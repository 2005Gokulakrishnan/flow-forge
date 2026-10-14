const express=require('express'); const session=require('express-session'); const PgSession=require('connect-pg-simple')(session); const {Pool}=require('pg');
const helmet=require('helmet'); const cors=require('cors'); const morgan=require('morgan'); const rateLimit=require('express-rate-limit'); const {z}=require('zod'); const crypto=require('crypto');
const config=require('./config'); const prisma=require('./db'); const google=require('./google'); const {executeWorkflow}=require('./engine');
const app=express();
if(config.isProd) app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false})); app.use(cors({origin:(origin,cb)=>{if(!origin||config.origins.includes(origin)) return cb(null,true); cb(new Error('Origin not allowed by CORS'));},credentials:true}));
app.use(express.json({limit:'1mb'})); app.use(morgan('dev'));
const pgPool=new Pool({connectionString:process.env.DATABASE_URL});
app.use(session({store:new PgSession({pool:pgPool,tableName:'session',createTableIfMissing:true}),secret:process.env.SESSION_SECRET||'development-only-secret-change-me',resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:config.isProd,sameSite:'lax',maxAge:7*24*60*60*1000}}));
const apiLimit=rateLimit({windowMs:60*1000,limit:120,standardHeaders:true,legacyHeaders:false}); app.use('/api',apiLimit);
function requireAuth(req,res,next){if(!req.session.userId)return res.status(401).json({error:'Sign in with Google to continue.'});next();}
function asyncRoute(fn){return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
app.get('/health',(req,res)=>res.json({ok:true,service:'FlowForge API',time:new Date().toISOString()}));
app.get('/auth/google', (req,res)=>{const state=crypto.randomBytes(24).toString('hex');req.session.oauthState=state;res.redirect(google.getAuthUrl(state));});
app.get('/auth/google/callback',asyncRoute(async(req,res)=>{
  if(!req.query.code||!req.query.state||req.query.state!==req.session.oauthState)return res.status(400).send('Invalid OAuth state. Return to FlowForge and try again.');
  delete req.session.oauthState; const client=google.oauthClient(); const {tokens}=await client.getToken(req.query.code);client.setCredentials(tokens);
  const oauth2=require('googleapis').google.oauth2({version:'v2',auth:client}); const {data:profile}=await oauth2.userinfo.get();
  if(!profile.id||!profile.email)return res.status(400).send('Google did not return a verified account identity.');
  const user=await prisma.user.upsert({where:{googleId:profile.id},create:{googleId:profile.id,email:profile.email,name:profile.name,picture:profile.picture},update:{email:profile.email,name:profile.name,picture:profile.picture}});
  await google.saveTokens(user.id,tokens,profile);req.session.userId=user.id;req.session.save(()=>res.redirect(config.frontendUrl+'/?connected=google'));
}));
app.post('/auth/logout',requireAuth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',requireAuth,asyncRoute(async(req,res)=>{const user=await prisma.user.findUnique({where:{id:req.session.userId},select:{id:true,email:true,name:true,picture:true,createdAt:true}});const connection=await prisma.googleConnection.findUnique({where:{userId_provider:{userId:req.session.userId,provider:'google'}},select:{googleEmail:true,createdAt:true}});res.json({user,googleConnected:!!connection,googleEmail:connection?.googleEmail||null});}));
app.get('/api/google/spreadsheets',requireAuth,asyncRoute(async(req,res)=>res.json({files:await google.listSpreadsheets(req.session.userId)})));
app.get('/api/google/spreadsheets/:id/tabs',requireAuth,asyncRoute(async(req,res)=>res.json(await google.listTabs(req.session.userId,req.params.id))));
const workflowSchema=z.object({name:z.string().min(1).max(120),description:z.string().max(500).optional(),active:z.boolean().optional(),definition:z.object({nodes:z.array(z.any()),edges:z.array(z.any())})});
app.get('/api/workflows',requireAuth,asyncRoute(async(req,res)=>{const items=await prisma.workflow.findMany({where:{userId:req.session.userId},orderBy:{updatedAt:'desc'},select:{id:true,name:true,description:true,active:true,webhookToken:true,createdAt:true,updatedAt:true}});res.json({workflows:items.map(w=>({...w,webhookUrl:`${config.appUrl}/hooks/${w.webhookToken}`}))});}));
app.post('/api/workflows',requireAuth,asyncRoute(async(req,res)=>{const parsed=workflowSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid workflow',details:parsed.error.flatten()});const w=await prisma.workflow.create({data:{...parsed.data,userId:req.session.userId,active:parsed.data.active??false}});res.status(201).json({...w,webhookUrl:`${config.appUrl}/hooks/${w.webhookToken}`} );}));
app.get('/api/workflows/:id',requireAuth,asyncRoute(async(req,res)=>{const w=await prisma.workflow.findFirst({where:{id:req.params.id,userId:req.session.userId}});if(!w)return res.status(404).json({error:'Workflow not found'});res.json({...w,webhookUrl:`${config.appUrl}/hooks/${w.webhookToken}`} );}));
app.put('/api/workflows/:id',requireAuth,asyncRoute(async(req,res)=>{const parsed=workflowSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid workflow',details:parsed.error.flatten()});const owned=await prisma.workflow.findFirst({where:{id:req.params.id,userId:req.session.userId},select:{id:true}});if(!owned)return res.status(404).json({error:'Workflow not found'});const w=await prisma.workflow.update({where:{id:owned.id},data:parsed.data});res.json(w);}));
app.delete('/api/workflows/:id',requireAuth,asyncRoute(async(req,res)=>{const r=await prisma.workflow.deleteMany({where:{id:req.params.id,userId:req.session.userId}});if(!r.count)return res.status(404).json({error:'Workflow not found'});res.json({ok:true});}));
app.post('/api/workflows/:id/test',requireAuth,asyncRoute(async(req,res)=>{const w=await prisma.workflow.findFirst({where:{id:req.params.id,userId:req.session.userId}});if(!w)return res.status(404).json({error:'Workflow not found'});const result=await executeWorkflow({workflow:w,userId:req.session.userId,input:req.body||{}});res.status(result.status==='success'?200:422).json(result);}));
app.get('/api/workflows/:id/executions',requireAuth,asyncRoute(async(req,res)=>{const w=await prisma.workflow.findFirst({where:{id:req.params.id,userId:req.session.userId},select:{id:true}});if(!w)return res.status(404).json({error:'Workflow not found'});const executions=await prisma.execution.findMany({where:{workflowId:w.id,userId:req.session.userId},orderBy:{startedAt:'desc'},take:100,include:{steps:{orderBy:{startedAt:'asc'}}}});res.json({executions});}));
// Public inbound webhook. A secret, unguessable token identifies the workflow; do not put PII in the URL.
app.post('/hooks/:token',rateLimit({windowMs:60*1000,limit:60,standardHeaders:true,legacyHeaders:false}),asyncRoute(async(req,res)=>{const w=await prisma.workflow.findUnique({where:{webhookToken:req.params.token}});if(!w||!w.active)return res.status(404).json({error:'Webhook not found or workflow is inactive.'});const result=await executeWorkflow({workflow:w,userId:w.userId,input:req.body||{}});res.status(result.status==='success'?200:502).json(result);}));
app.use(express.static(require('path').join(__dirname,'../public')));
app.use((err,req,res,next)=>{console.error(err);const status=err.status|| (err.code==='P2002'?409:500);res.status(status).json({error:status===500?'Internal server error':err.message, ...(process.env.NODE_ENV==='development'?{detail:err.message}:{})});});
const server=app.listen(config.port,()=>console.log(`FlowForge listening on ${config.appUrl}`));
async function shutdown(){server.close();await prisma.$disconnect();await pgPool.end();process.exit(0);}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
