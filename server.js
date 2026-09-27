const express=require("express");
const path=require("path");
const fs=require("fs");
const multer=require("multer");
const crypto=require("crypto");
const Database=require("better-sqlite3");
const {Pool}=require("pg");
const {v2:cloudinary}=require("cloudinary");

const app=express();
const PORT=process.env.PORT||3000;
const configuredStoreName=String(process.env.STORE_NAME||"").trim();
const STORE_NAME=/^brand\s*shoes(?:\s+bahirdar)?$/i.test(configuredStoreName)?"YOUR OWN STORE":(configuredStoreName||"YOUR OWN STORE");
const CURRENCY=process.env.CURRENCY||"ETB";
const WHATSAPP=String(process.env.WHATSAPP_NUMBER||"251945306592").replace(/\D/g,"");
const ADMIN_USER=process.env.ADMIN_USER||"admin";
const ADMIN_PASS=process.env.ADMIN_PASS||"change-this-password";
const SMS_API_KEY=String(process.env.SMS_API_KEY||"").trim();
const SMS_ADMIN_PHONE=String(process.env.SMS_ADMIN_PHONE||"251945306592").replace(/\D/g,"");
const SMS_ENABLED=Boolean(SMS_API_KEY && SMS_ADMIN_PHONE);
const CUSTOMER_SESSION_DAYS=30;
function hashPassword(password,salt){return crypto.scryptSync(String(password),salt,64).toString("hex");}
function makePasswordHash(password){const salt=crypto.randomBytes(16).toString("hex");return `${salt}:${hashPassword(password,salt)}`;}
function verifyPassword(password,stored){try{const [salt,hash]=String(stored||"").split(":");if(!salt||!hash)return false;const actual=hashPassword(password,salt);return crypto.timingSafeEqual(Buffer.from(actual,"hex"),Buffer.from(hash,"hex"));}catch(e){return false;}}
function customerToken(){return crypto.randomBytes(32).toString("hex");}

async function sendAdminSMS(message, recipientPhone=""){
 if(!SMS_ENABLED){
  console.log("SMS notification skipped: SMS_API_KEY or SMS_ADMIN_PHONE is not configured.");
  return {sent:false,skipped:true};
 }
 try{
  const destination=String(recipientPhone||SMS_ADMIN_PHONE).replace(/\D/g,"");
  if(!destination)return {sent:false,skipped:true};
  const response=await fetch("https://smsethiopia.com/api/sms/send",{
   method:"POST",
   headers:{"KEY":SMS_API_KEY,"Content-Type":"application/json"},
   body:JSON.stringify({msisdn:destination,text:message})
  });
  const text=await response.text();
  let data={}; try{data=JSON.parse(text)}catch(e){data={raw:text}}
  if(!response.ok || data.status && String(data.status).toLowerCase()==="error") throw new Error(`SMSEthiopia HTTP ${response.status}: ${text}`);
  console.log("Admin SMS sent:",data);
  return {sent:true,data};
 }catch(e){
  console.error("Admin SMS notification failed:",e.message);
  return {sent:false,error:e.message};
 }
}

const usePg=!!process.env.DATABASE_URL;
let db, pgPool;

const schema=`
CREATE TABLE IF NOT EXISTS stores(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 store_id INTEGER NOT NULL, username TEXT NOT NULL UNIQUE, full_name TEXT DEFAULT '', phone TEXT DEFAULT '', password_hash TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, is_main_admin INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_sessions(
 token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, expires_at TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS store_settings(
 store_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(store_id,key)
);
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 store_id INTEGER, name TEXT NOT NULL, brand TEXT DEFAULT '', price REAL NOT NULL,
 old_price REAL, sizes TEXT DEFAULT '', stock INTEGER NOT NULL DEFAULT 0, size_stock TEXT DEFAULT '{}', colors TEXT DEFAULT '', color_stock TEXT DEFAULT '{}', color_images TEXT DEFAULT '{}',
 category TEXT DEFAULT 'Shoes', image TEXT DEFAULT '',
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 store_id INTEGER, customer TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
 customer_id INTEGER, notes TEXT DEFAULT '', items TEXT NOT NULL, total REAL NOT NULL,
 payment_method TEXT DEFAULT 'NONE', status TEXT DEFAULT 'NEW', admin_seen INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings(
 key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, email TEXT DEFAULT '', address TEXT DEFAULT '', password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customer_sessions(
 token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires_at TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 admin_id INTEGER NOT NULL, store_id INTEGER NOT NULL, amount REAL NOT NULL DEFAULT 0, payment_method TEXT DEFAULT '', reference TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, paid_at TIMESTAMP
);`;

if(usePg){
  pgPool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes("localhost")?false:{rejectUnauthorized:false}});
}else{
  db=new Database(path.join(__dirname,"store.db"));
  db.pragma("journal_mode=WAL");
}

function localImageToDataUrl(imagePath){
 try{
  if(!imagePath || !String(imagePath).startsWith("/uploads/")) return null;
  const filename=path.basename(String(imagePath));
  const full=path.join(uploadsDir,filename);
  if(!fs.existsSync(full)) return null;
  const ext=path.extname(filename).toLowerCase();
  const mime={".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".gif":"image/gif",".avif":"image/avif"}[ext]||"application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
 }catch(e){
  console.error("Image migration read failed:",e.message);
  return null;
}
}

async function migrateLocalImagesToDatabase(){
 // Render's local filesystem is ephemeral. If old images still exist locally,
 // convert them into database-backed data URLs before a future restart/redeploy.
 if(!usePg) return;
 try{
  const products=await q("SELECT id,image,color_images FROM products");
  for(const p of products.rows){
   let nextImage=p.image||"", changed=false;
   const migrated=localImageToDataUrl(p.image);
   if(migrated){ nextImage=migrated; changed=true; }

   let colors={};
   try{ colors=JSON.parse(p.color_images||"{}"); }catch(e){ colors={}; }
   for(const key of Object.keys(colors)){
    const m=localImageToDataUrl(colors[key]);
    if(m){ colors[key]=m; changed=true; }
   }
   if(changed){
    await run("UPDATE products SET image=?, color_images=? WHERE id=?",[nextImage,JSON.stringify(colors),p.id]);
    console.log(`Persisted image(s) for product #${p.id} into PostgreSQL.`);
   }
  }
 }catch(e){
  console.error("Image persistence migration:",e.message);
 }
}


function slugifyStoreName(name){
 const base=String(name||"store").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,45)||"store";
 return base;
}
async function uniqueStoreSlug(name){
 const base=slugifyStoreName(name); let slug=base, n=1;
 while(await one("SELECT id FROM stores WHERE slug=?",[slug])){n++;slug=`${base}-${n}`;}
 return slug;
}
async function ensureMultiStoreSchema(){
 // Add admin control columns to existing databases.
 try{
  if(usePg){
   await pgPool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1");
   await pgPool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_main_admin INTEGER NOT NULL DEFAULT 0");
  }else{
   try{db.exec("ALTER TABLE admins ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")}catch(e){if(!String(e.message).toLowerCase().includes("duplicate column"))throw e;}
   try{db.exec("ALTER TABLE admins ADD COLUMN is_main_admin INTEGER NOT NULL DEFAULT 0")}catch(e){if(!String(e.message).toLowerCase().includes("duplicate column"))throw e;}
  }
 }catch(e){console.error("admin control migration:",e.message)}
 // Add store ownership columns to existing tables.
 for(const table of ["products","orders"]){
  try{
   if(usePg) await pgPool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS store_id INTEGER`);
   else { try{db.exec(`ALTER TABLE ${table} ADD COLUMN store_id INTEGER`)}catch(e){if(!String(e.message).toLowerCase().includes("duplicate column"))throw e;} }
  }catch(e){console.error(`store_id migration for ${table}:`,e.message)}
 }
 let store=await one("SELECT * FROM stores ORDER BY id ASC LIMIT 1");
 if(!store){
  const name=STORE_NAME; const slug=await uniqueStoreSlug(name);
  if(usePg){const r=await pgPool.query("INSERT INTO stores(name,slug) VALUES($1,$2) RETURNING id,name,slug",[name,slug]);store=r.rows[0];}
  else {const r=db.prepare("INSERT INTO stores(name,slug) VALUES(?,?)").run(name,slug);store=await one("SELECT * FROM stores WHERE id=?",[r.lastInsertRowid]);}
 }
 await run("UPDATE products SET store_id=? WHERE store_id IS NULL",[store.id]);
 await run("UPDATE orders SET store_id=? WHERE store_id IS NULL",[store.id]);
 // Copy legacy single-store settings into the default store's isolated settings table.
 const legacy=await q("SELECT key,value FROM settings");
 for(const row of legacy.rows){
  const exists=await one("SELECT value FROM store_settings WHERE store_id=? AND key=?",[store.id,row.key]);
  if(!exists) await run("INSERT INTO store_settings(store_id,key,value) VALUES(?,?,?)",[store.id,row.key,row.value]);
 }
 // The Render environment credentials always identify the Main Admin.
 // If that admin does not exist yet, create it in the default store.
 let mainAdmin=await one("SELECT * FROM admins WHERE username=?",[ADMIN_USER]);
 if(!mainAdmin){
  const ph=makePasswordHash(ADMIN_PASS);
  if(usePg){await pgPool.query("INSERT INTO admins(store_id,username,full_name,password_hash,is_active,is_main_admin) VALUES($1,$2,$3,$4,1,1)",[store.id,ADMIN_USER,"Main Admin",ph]);}
  else db.prepare("INSERT INTO admins(store_id,username,full_name,password_hash,is_active,is_main_admin) VALUES(?,?,?,?,1,1)").run(store.id,ADMIN_USER,"Main Admin",ph);
 }else{
  // Keep the Render-configured account as the single Main Admin.
  await run("UPDATE admins SET is_main_admin=CASE WHEN username=? THEN 1 ELSE 0 END WHERE username=? OR is_main_admin=1",[ADMIN_USER,ADMIN_USER]);
 }
 // Give every new store sensible payment/settings defaults when it is created.
}
async function getStoreBySlug(slug){
 if(slug){return await one("SELECT * FROM stores WHERE slug=?",[slug]);}
 return await one("SELECT * FROM stores ORDER BY id ASC LIMIT 1");
}
async function getPublicStore(req){
 const slug=String(req.query.store||req.headers["x-store-slug"]||"").trim();
 const store=await getStoreBySlug(slug);
 return store;
}
async function getSetting(storeId,key, fallback=""){
 const row=await one("SELECT value FROM store_settings WHERE store_id=? AND key=?",[storeId,key]);
 return row?String(row.value??""):fallback;
}
async function setSetting(storeId,key,value){
 const row=await one("SELECT value FROM store_settings WHERE store_id=? AND key=?",[storeId,key]);
 if(row) await run("UPDATE store_settings SET value=? WHERE store_id=? AND key=?",[String(value),storeId,key]);
 else await run("INSERT INTO store_settings(store_id,key,value) VALUES(?,?,?)",[storeId,key,String(value)]);
}
function adminToken(){return crypto.randomBytes(32).toString("hex");}
async function getAdminFromToken(token){
 if(!token)return null;
 return await one("SELECT a.id,a.store_id,a.username,a.full_name,a.phone,a.is_active,a.is_main_admin,s.name AS store_name,s.slug AS store_slug FROM admin_sessions x JOIN admins a ON a.id=x.admin_id JOIN stores s ON s.id=a.store_id WHERE x.token=? AND x.expires_at>CURRENT_TIMESTAMP AND a.is_active=1",[token]);
}
async function getAdminStore(req){return req.admin?.store_id?await one("SELECT * FROM stores WHERE id=?",[req.admin.store_id]):null;}

async function initDb(){
 if(usePg){ await pgPool.query(schema); }
 else { db.exec(schema.replace(/INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY/g,"INTEGER PRIMARY KEY AUTOINCREMENT")); }
 await ensureMultiStoreSchema();
 // Admin notification migration for existing stores.
 try {
  if(usePg) await pgPool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_seen INTEGER NOT NULL DEFAULT 0");
  else { try { db.exec("ALTER TABLE orders ADD COLUMN admin_seen INTEGER NOT NULL DEFAULT 0"); } catch(e) { if(!String(e.message).includes("duplicate column")) throw e; } }
 } catch(e) { console.error("admin notification migration:",e.message); }
 // Customer order history and optional payment method migrations.
 try {
  if(usePg){
   await pgPool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER; ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'NONE'");
  } else {
   try { db.exec("ALTER TABLE orders ADD COLUMN customer_id INTEGER"); } catch(e) { if(!String(e.message).includes("duplicate column")) throw e; }
   try { db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT 'NONE'"); } catch(e) { if(!String(e.message).includes("duplicate column")) throw e; }
  }
 } catch(e) { console.error("customer/payment migration:",e.message); }
 // Per-size inventory migration for existing stores.
 try {
  if(usePg) await pgPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS size_stock TEXT DEFAULT '{}'; ALTER TABLE products ADD COLUMN IF NOT EXISTS colors TEXT DEFAULT ''; ALTER TABLE products ADD COLUMN IF NOT EXISTS color_stock TEXT DEFAULT '{}'; ALTER TABLE products ADD COLUMN IF NOT EXISTS color_images TEXT DEFAULT '{}'");
  else { try { db.exec("ALTER TABLE products ADD COLUMN size_stock TEXT DEFAULT '{}'"); try { db.exec("ALTER TABLE products ADD COLUMN colors TEXT DEFAULT ''"); } catch(e) { if(!String(e.message).includes('duplicate column')) throw e; } try { db.exec("ALTER TABLE products ADD COLUMN color_stock TEXT DEFAULT '{}'"); } catch(e) { if(!String(e.message).includes('duplicate column')) throw e; } try { db.exec("ALTER TABLE products ADD COLUMN color_images TEXT DEFAULT '{}'"); } catch(e) { if(!String(e.message).includes('duplicate column')) throw e; } } catch(e) { if(!String(e.message).includes("duplicate column")) throw e; } }
  const oldProducts=await q("SELECT id,sizes,stock,size_stock FROM products");
  for(const p of oldProducts.rows){
   let current={}; try { current=JSON.parse(p.size_stock||"{}"); } catch(e) {}
   if(!current || Object.keys(current).length===0){
    const sizes=String(p.sizes||"").split(",").map(x=>x.trim()).filter(Boolean);
    const total=Math.max(0,Number(p.stock)||0), base=sizes.length?Math.floor(total/sizes.length):0, rem=sizes.length?total%sizes.length:0;
    for(let i=0;i<sizes.length;i++) current[sizes[i]]=base+(i<rem?1:0);
    await run("UPDATE products SET size_stock=? WHERE id=?",[JSON.stringify(current),p.id]);
   }
  }
 } catch(e) { console.error("size inventory migration:",e.message); }
 const count=await q("SELECT COUNT(*) AS n FROM products");
 if(Number(count.rows?count.rows[0].n:count[0].n)===0){
  const demo=[
   ["Nike Air Force 1 White","Nike",1200,1400,"39,40,41,42,43",5,"Air Force 1",""],
   ["Nike Air Force 1 Black","Nike",1250,1450,"39,40,41,42,43",5,"Air Force 1",""],
   ["Nike Air Force 1 White/Black","Nike",1300,1500,"40,41,42,43,44",4,"Air Force 1",""],
   ["Nike Air Force 1 Triple White","Nike",1350,1550,"39,40,41,42,43,44",3,"Air Force 1",""],
   ["Nike Air Force 1 Black/White","Nike",1280,1480,"40,41,42,43",4,"Air Force 1",""]
  ];
  for(const p of demo){
   const sizes=p[4].split(","), base=Math.floor(p[5]/sizes.length), rem=p[5]%sizes.length;
   const sizeStock=Object.fromEntries(sizes.map((z,i)=>[z,base+(i<rem?1:0)]));
   const vals=[...p.slice(0,5),p[5],JSON.stringify(sizeStock),"","{}","{}",p[6],p[7]];
   if(usePg) await pgPool.query(`INSERT INTO products(name,brand,price,old_price,sizes,stock,size_stock,colors,color_stock,color_images,category,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,vals);
   else db.prepare("INSERT INTO products(name,brand,price,old_price,sizes,stock,size_stock,colors,color_stock,color_images,category,image) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...vals);
  }
 }
 const defaultStore=await getStoreBySlug("");
 const defaults={whatsapp:WHATSAPP,delivery_fee:"0",coupon_code:"",coupon_percent:"0",payment_telebirr:"",payment_telebirr_enabled:"0",payment_telebirr_link:"",payment_bank:"",payment_bank_enabled:"0",payment_bank_link:"",payment_mastercard_details:"",payment_mastercard_enabled:"0",payment_mastercard_link:""};
 for(const [key,value] of Object.entries(defaults)){const row=await one("SELECT value FROM store_settings WHERE store_id=? AND key=?",[defaultStore.id,key]);if(!row)await setSetting(defaultStore.id,key,value);}

}

async function q(sql,params=[]){
 if(usePg){
  let converted=sql.replace(/\?/g,()=>"$"+(++q._i));
  // reset placeholder counter per query
  q._i=0;
  // Better: callers use ? placeholders; rebuild deterministically.
  let i=0; converted=sql.replace(/\?/g,()=>"$"+(++i));
  return pgPool.query(converted,params);
 }
 return {rows:db.prepare(sql).all(...params)};
}
async function one(sql,params=[]){
 if(usePg){let i=0;let s=sql.replace(/\?/g,()=>"$"+(++i));return (await pgPool.query(s,params)).rows[0]||null;}
 return db.prepare(sql).get(...params)||null;
}
async function run(sql,params=[]){
 if(usePg){let i=0;let s=sql.replace(/\?/g,()=>"$"+(++i));return pgPool.query(s,params);}
 return db.prepare(sql).run(...params);
}

const uploadsDir=path.join(__dirname,"uploads"); fs.mkdirSync(uploadsDir,{recursive:true});
cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:6*1024*1024,files:30}});

app.use(express.json({limit:"1mb"}));
app.use("/uploads",express.static(uploadsDir));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

async function auth(req,res,next){
 try{
  const h=req.headers.authorization||"";
  let admin=null;
  if(h.startsWith("Bearer ")) admin=await getAdminFromToken(h.slice(7).trim());
  if(!admin && h.startsWith("Basic ")){
   const raw=Buffer.from(h.slice(6),"base64").toString(); const pos=raw.indexOf(":");
   const u=pos>=0?raw.slice(0,pos):raw, p=pos>=0?raw.slice(pos+1):"";
   const a=await one("SELECT a.id,a.store_id,a.username,a.full_name,a.phone,a.is_active,a.is_main_admin,s.name AS store_name,s.slug AS store_slug,a.password_hash FROM admins a JOIN stores s ON s.id=a.store_id WHERE a.username=?",[u]);
   if(a && Number(a.is_active)!==0 && verifyPassword(p,a.password_hash)){admin=a;}
  }
  if(!admin)return res.status(401).json({error:"Admin sign in required."});
  req.admin=admin; next();
 }catch(e){res.status(500).json({error:e.message})}
}
function imgUrl(req,file){
 if(!file)return "";
 if(process.env.CLOUDINARY_CLOUD_NAME){
  return new Promise((resolve,reject)=>{
   const stream=cloudinary.uploader.upload_stream({folder:`brand-shoes/${req.admin?.store_slug||"default"}`},(err,result)=>err?reject(err):resolve(result.secure_url));
   stream.end(file.buffer);
  });
 }

 // When PostgreSQL is available, store the image itself in the database.
 // This prevents Render redeploys/restarts from deleting product photos.
 if(usePg){
  const mime=String(file.mimetype||"image/jpeg").split(";")[0];
  return `data:${mime};base64,${file.buffer.toString("base64")}`;
 }

 // Local development fallback.
 const name=Date.now()+"-"+crypto.randomBytes(4).toString("hex")+"-"+file.originalname.replace(/[^a-zA-Z0-9._-]/g,"");
 fs.writeFileSync(path.join(uploadsDir,name),file.buffer);
 return "/uploads/"+name;
}

app.get("/api/config",async(req,res)=>{
 try{
  const store=await getPublicStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const w=await getSetting(store.id,"whatsapp",WHATSAPP), d=await getSetting(store.id,"delivery_fee","0");
  res.json({storeId:store.id,storeSlug:store.slug,storeName:store.name,currency:CURRENCY,whatsapp:w,deliveryFee:Math.max(0,Number(d||0))});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/admin/me",auth,async(req,res)=>{const name=(await one("SELECT name FROM stores WHERE id=?",[req.admin.store_id]))?.name||req.admin.store_name;res.json({id:req.admin.id,username:req.admin.username,fullName:req.admin.full_name,phone:req.admin.phone,storeId:req.admin.store_id,storeName:name,storeSlug:req.admin.store_slug,storeUrl:`${req.protocol}://${req.get("host")}/?store=${encodeURIComponent(req.admin.store_slug)}`,isMainAdmin:Number(req.admin.is_main_admin)===1,whatsapp:await getSetting(req.admin.store_id,"whatsapp",WHATSAPP),deliveryFee:Number(await getSetting(req.admin.store_id,"delivery_fee","0"))})});
app.post("/api/admin/register",async(req,res)=>{
 try{
  const fullName=String(req.body.fullName||"").trim(), username=String(req.body.username||"").trim(), phone=String(req.body.phone||"").trim(), storeName=String(req.body.storeName||"").trim(), password=String(req.body.password||"");
  if(fullName.length<2||username.length<3||storeName.length<2||password.length<6)return res.status(400).json({error:"Enter your name, store name, username and a password of at least 6 characters."});
  if(!/^[A-Za-z0-9_.-]+$/.test(username))return res.status(400).json({error:"Username may contain letters, numbers, dots, underscores and hyphens."});
  if(await one("SELECT id FROM admins WHERE username=?",[username]))return res.status(409).json({error:"That admin username is already in use."});
  const slug=await uniqueStoreSlug(storeName); let storeId;
  if(usePg){const sr=await pgPool.query("INSERT INTO stores(name,slug) VALUES($1,$2) RETURNING id",[storeName,slug]);storeId=sr.rows[0].id;}
  else storeId=db.prepare("INSERT INTO stores(name,slug) VALUES(?,?)").run(storeName,slug).lastInsertRowid;
  const ph=makePasswordHash(password); let adminId;
  if(usePg){const ar=await pgPool.query("INSERT INTO admins(store_id,username,full_name,phone,password_hash,is_active,is_main_admin) VALUES($1,$2,$3,$4,$5,1,0) RETURNING id",[storeId,username,fullName,phone,ph]);adminId=ar.rows[0].id;}
  else adminId=db.prepare("INSERT INTO admins(store_id,username,full_name,phone,password_hash,is_active,is_main_admin) VALUES(?,?,?,?,?,1,0)").run(storeId,username,fullName,phone,ph).lastInsertRowid;
  const defaults={whatsapp:WHATSAPP,delivery_fee:"0",coupon_code:"",coupon_percent:"0",payment_telebirr:"",payment_telebirr_enabled:"0",payment_telebirr_link:"",payment_bank:"",payment_bank_enabled:"0",payment_bank_link:"",payment_mastercard_details:"",payment_mastercard_enabled:"0",payment_mastercard_link:""};
  for(const [key,value] of Object.entries(defaults))await setSetting(storeId,key,value);
  const token=adminToken();
  await run(usePg?"INSERT INTO admin_sessions(token,admin_id,expires_at) VALUES(?,?,CURRENT_TIMESTAMP + INTERVAL '30 days')":"INSERT INTO admin_sessions(token,admin_id,expires_at) VALUES(?,?,datetime('now','+30 days'))",[token,adminId]);
  res.json({ok:true,token,admin:{id:adminId,username,fullName,phone,storeId,storeName,storeSlug:slug,storeUrl:`/?store=${encodeURIComponent(slug)}`,isMainAdmin:false}});
 }catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/admin/login",async(req,res)=>{
 try{
  const user=String(req.body.username||"").trim(),pass=String(req.body.password||"");
  const a=await one("SELECT a.id,a.store_id,a.username,a.full_name,a.phone,a.password_hash,a.is_active,a.is_main_admin,s.name AS store_name,s.slug AS store_slug FROM admins a JOIN stores s ON s.id=a.store_id WHERE a.username=?",[user]);
  if(!a||Number(a.is_active)===0||!verifyPassword(pass,a.password_hash))return res.status(401).json({error:Number(a?.is_active)===0?"This admin account has been disabled by the Main Admin.":"Invalid admin username or password."});
  const token=adminToken(); await run(usePg?"INSERT INTO admin_sessions(token,admin_id,expires_at) VALUES(?,?,CURRENT_TIMESTAMP + INTERVAL '30 days')":"INSERT INTO admin_sessions(token,admin_id,expires_at) VALUES(?,?,datetime('now','+30 days'))",[token,a.id]);
  res.json({ok:true,token,admin:{id:a.id,username:a.username,fullName:a.full_name,phone:a.phone,storeId:a.store_id,storeName:a.store_name,storeSlug:a.store_slug,storeUrl:`/?store=${encodeURIComponent(a.store_slug)}`,isMainAdmin:Number(a.is_main_admin)===1}});
 }catch(e){res.status(500).json({error:e.message})}
});
function mainAdminOnly(req,res,next){
 if(!req.admin || Number(req.admin.is_main_admin)!==1) return res.status(403).json({error:"Main Admin access required."});
 next();
}
app.get("/api/main-admin/admins",auth,mainAdminOnly,async(req,res)=>{
 const result=await q("SELECT a.id,a.username,a.full_name,a.phone,a.is_active,a.is_main_admin,a.created_at,s.id AS store_id,s.name AS store_name,s.slug AS store_slug FROM admins a JOIN stores s ON s.id=a.store_id ORDER BY a.id ASC");
 res.json(result.rows.map(a=>({...a,isActive:Number(a.is_active)===1,isMainAdmin:Number(a.is_main_admin)===1,storeUrl:`/?store=${encodeURIComponent(a.store_slug)}`})));
});
app.patch("/api/main-admin/admins/:id/status",auth,mainAdminOnly,async(req,res)=>{
 const id=Number(req.params.id), active=Boolean(req.body?.active);
 const target=await one("SELECT id,username,is_main_admin FROM admins WHERE id=?",[id]);
 if(!target)return res.status(404).json({error:"Admin not found."});
 if(Number(target.is_main_admin)===1 || target.username===ADMIN_USER)return res.status(400).json({error:"The Main Admin account cannot be disabled."});
 await run("UPDATE admins SET is_active=? WHERE id=?",[active?1:0,id]);
 if(!active) await run("DELETE FROM admin_sessions WHERE admin_id=?",[id]);
 res.json({ok:true,isActive:active});
});
app.delete("/api/main-admin/admins/:id",auth,mainAdminOnly,async(req,res)=>{
 const id=Number(req.params.id), target=await one("SELECT id,username,is_main_admin FROM admins WHERE id=?",[id]);
 if(!target)return res.status(404).json({error:"Admin not found."});
 if(Number(target.is_main_admin)===1 || target.username===ADMIN_USER)return res.status(400).json({error:"The Main Admin account cannot be deleted."});
 await run("DELETE FROM admin_sessions WHERE admin_id=?",[id]);
 await run("DELETE FROM admins WHERE id=?",[id]);
 res.json({ok:true});
});
app.post("/api/admin/logout",auth,async(req,res)=>{try{const h=req.headers.authorization||"";if(h.startsWith("Bearer "))await run("DELETE FROM admin_sessions WHERE token=?",[h.slice(7).trim()]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.put("/api/settings/store",auth,async(req,res)=>{
 try{
  const name=String(req.body.storeName||"").trim();
  if(name.length<2||name.length>80)return res.status(400).json({error:"Store name must be between 2 and 80 characters."});
  await run("UPDATE stores SET name=? WHERE id=?",[name,req.admin.store_id]);
  res.json({ok:true,storeName:name});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/settings/whatsapp",auth,async(req,res)=>{
 try{
  const number=String(req.body.whatsapp||"").replace(/\D/g,"");
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  if(number.length<8 || number.length>15)return res.status(400).json({error:"Enter a valid WhatsApp number in international format, e.g. 251945306592."});
  await setSetting(store.id,"whatsapp",number);
  res.json({ok:true,whatsapp:number});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/settings/delivery",auth,async(req,res)=>{
 try{
  const fee=Number(req.body.deliveryFee);
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  if(!Number.isFinite(fee)||fee<0)return res.status(400).json({error:"Enter a valid delivery price of 0 or more."});
  await setSetting(store.id,"delivery_fee",String(fee));
  res.json({ok:true,deliveryFee:fee});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/coupon",async(req,res)=>{
 try{
  const entered=String(req.query.code||"").trim().toUpperCase();
  const store=await getPublicStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const codeRow={value:await getSetting(store.id,"coupon_code","")};
  const percentRow={value:await getSetting(store.id,"coupon_percent","0")};
  const configured=String(codeRow&&codeRow.value||"").trim().toUpperCase();
  const percent=Math.min(100,Math.max(0,Number(percentRow&&percentRow.value||0)));
  if(!entered || !configured || percent<=0 || entered!==configured)return res.status(400).json({valid:false,error:"Invalid or expired discount coupon."});
  res.json({valid:true,code:configured,percent});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/settings/coupon",auth,async(req,res)=>{
 try{
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const codeRow={value:await getSetting(store.id,"coupon_code","")};
  const percentRow={value:await getSetting(store.id,"coupon_percent","0")};
  res.json({couponCode:String(codeRow&&codeRow.value||""),couponPercent:Math.min(100,Math.max(0,Number(percentRow&&percentRow.value||0)))});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/settings/coupon",auth,async(req,res)=>{
 try{
  const code=String(req.body.couponCode||"").trim().toUpperCase().replace(/\s+/g,"");
  const percent=Number(req.body.couponPercent);
  if(code && !/^[A-Z0-9_-]{3,30}$/.test(code))return res.status(400).json({error:"Coupon code must be 3-30 letters, numbers, hyphens or underscores."});
  if(!Number.isFinite(percent)||percent<0||percent>100)return res.status(400).json({error:"Discount percent must be between 0 and 100."});
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  await setSetting(store.id,"coupon_code",code); await setSetting(store.id,"coupon_percent",String(percent));
  res.json({ok:true,couponCode:code,couponPercent:percent});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/payment-options",async(req,res)=>{
 try{
  const store=await getPublicStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const keys=["payment_telebirr","payment_telebirr_enabled","payment_telebirr_link","payment_bank","payment_bank_enabled","payment_bank_link","payment_mastercard_details","payment_mastercard_enabled","payment_mastercard_link"];
  const v={}; for(const key of keys)v[key]=await getSetting(store.id,key,"");
  res.json({telebirr:v.payment_telebirr||"",telebirrEnabled:v.payment_telebirr_enabled==="1",telebirrDetails:v.payment_telebirr||"",telebirrLink:v.payment_telebirr_link||"",bank:v.payment_bank||"",bankEnabled:v.payment_bank_enabled==="1",bankDetails:v.payment_bank||"",bankLink:v.payment_bank_link||"",mastercardDetails:v.payment_mastercard_details||"",mastercardEnabled:v.payment_mastercard_enabled==="1",mastercardLink:v.payment_mastercard_link||""});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/settings/payment",auth,async(req,res)=>{
 try{
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const keys=["payment_telebirr","payment_telebirr_enabled","payment_telebirr_link","payment_bank","payment_bank_enabled","payment_bank_link","payment_mastercard_details","payment_mastercard_enabled","payment_mastercard_link"];
  const v={}; for(const key of keys)v[key]=await getSetting(store.id,key,"");
  res.json({telebirr:v.payment_telebirr||"",telebirrEnabled:v.payment_telebirr_enabled==="1",telebirrLink:v.payment_telebirr_link||"",bank:v.payment_bank||"",bankEnabled:v.payment_bank_enabled==="1",bankLink:v.payment_bank_link||"",mastercardDetails:v.payment_mastercard_details||"",mastercardEnabled:v.payment_mastercard_enabled==="1",mastercardLink:v.payment_mastercard_link||""});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/settings/payment",auth,async(req,res)=>{
 try{
  const values={payment_telebirr:String(req.body.telebirr||"").trim(),payment_telebirr_enabled:req.body.telebirrEnabled?"1":"0",payment_telebirr_link:String(req.body.telebirrLink||"").trim(),payment_bank:String(req.body.bank||"").trim(),payment_bank_enabled:req.body.bankEnabled?"1":"0",payment_bank_link:String(req.body.bankLink||"").trim(),payment_mastercard_details:String(req.body.mastercardDetails||"").trim(),payment_mastercard_enabled:req.body.mastercardEnabled?"1":"0",payment_mastercard_link:String(req.body.mastercardLink||"").trim()};
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  for(const [key,value] of Object.entries(values))await setSetting(store.id,key,value);
  res.json({ok:true,telebirr:values.payment_telebirr,telebirrEnabled:values.payment_telebirr_enabled==="1",telebirrLink:values.payment_telebirr_link,bank:values.payment_bank,bankEnabled:values.payment_bank_enabled==="1",bankLink:values.payment_bank_link,mastercardDetails:values.payment_mastercard_details,mastercardEnabled:values.payment_mastercard_enabled==="1",mastercardLink:values.payment_mastercard_link});
 }catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/payment/start",async(req,res)=>{
 try{
  const method=String(req.body.method||"").toUpperCase();
  const store=await getPublicStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const map={MASTERCARD:{enabled:"payment_mastercard_enabled",link:"payment_mastercard_link",name:"Mastercard"},TELEBIRR:{enabled:"payment_telebirr_enabled",link:"payment_telebirr_link",name:"Telebirr"},BANK:{enabled:"payment_bank_enabled",link:"payment_bank_link",name:"Bank transfer"}};
  const cfg=map[method]; if(!cfg)return res.status(400).json({error:"Choose Pay later or a configured payment method."});
  const en={value:await getSetting(store.id,cfg.enabled,"0")}; if(String(en?.value||"")!=="1")return res.status(400).json({error:cfg.name+" is currently unavailable. Please choose Pay later or try another payment method."});
  const link={value:await getSetting(store.id,cfg.link,"")};
  if(!String(link?.value||"").trim())return res.status(400).json({error:cfg.name+" is enabled but its payment gateway/link has not been configured yet. Ask the admin to finish payment setup."});
  res.json({ok:true,url:String(link.value).trim(),method});
 }catch(e){res.status(500).json({error:e.message})}
});

function customerFromRequest(req){
 const token=String(req.headers["x-customer-token"]||req.cookies?.customer_token||"").trim();
 if(!token)return null;
 return token;
}
async function getCustomer(req){
 const token=customerFromRequest(req);
 if(!token)return null;
 const row=await one("SELECT c.id,c.name,c.phone,c.email,c.address,s.token,s.expires_at FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE s.token=? AND s.expires_at>CURRENT_TIMESTAMP",[token]);
 return row||null;
}
app.post("/api/customer/register",async(req,res)=>{
 try{
  const name=String(req.body.name||"").trim(),phone=String(req.body.phone||"").trim(),email=String(req.body.email||"").trim(),address=String(req.body.address||"").trim(),password=String(req.body.password||"");
  if(name.length<2||phone.length<5||password.length<6)return res.status(400).json({error:"Please provide your name, a valid phone number, and a password of at least 6 characters."});
  const existing=await one("SELECT id FROM customers WHERE phone=?",[phone]);
  if(existing)return res.status(409).json({error:"An account with this phone number already exists. Please sign in."});
  const ph=makePasswordHash(password);
  let customer;
  if(usePg){const r=await pgPool.query("INSERT INTO customers(name,phone,email,address,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,name,phone,email,address",[name,phone,email,address,ph]);customer=r.rows[0];}
  else {const r=db.prepare("INSERT INTO customers(name,phone,email,address,password_hash) VALUES(?,?,?,?,?)").run(name,phone,email,address,ph);customer=await one("SELECT id,name,phone,email,address FROM customers WHERE id=?",[r.lastInsertRowid]);}
  const token=customerToken();
  await run(usePg?"INSERT INTO customer_sessions(token,customer_id,expires_at) VALUES(?,?,CURRENT_TIMESTAMP + INTERVAL '30 days')":"INSERT INTO customer_sessions(token,customer_id,expires_at) VALUES(?,?,datetime('now','+30 days'))",[token,customer.id]);
  res.json({token,customer});
 }catch(e){
  if(String(e.message).toLowerCase().includes("unique"))return res.status(409).json({error:"An account with this phone number already exists."});
  res.status(500).json({error:e.message});
 }
});
app.post("/api/customer/login",async(req,res)=>{
 try{
  const phone=String(req.body.phone||"").trim(),password=String(req.body.password||"");
  const customer=await one("SELECT * FROM customers WHERE phone=?",[phone]);
  if(!customer||!verifyPassword(password,customer.password_hash))return res.status(401).json({error:"Incorrect phone number or password."});
  const token=customerToken();
  await run(usePg?"INSERT INTO customer_sessions(token,customer_id,expires_at) VALUES(?,?,CURRENT_TIMESTAMP + INTERVAL '30 days')":"INSERT INTO customer_sessions(token,customer_id,expires_at) VALUES(?,?,datetime('now','+30 days'))",[token,customer.id]);
  delete customer.password_hash;
  res.json({token,customer});
 }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/customer/me",async(req,res)=>{try{const c=await getCustomer(req);if(!c)return res.status(401).json({error:"Not signed in."});res.json({id:c.id,name:c.name,phone:c.phone,email:c.email,address:c.address});}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/customer/logout",async(req,res)=>{try{const token=customerFromRequest(req);if(token)await run("DELETE FROM customer_sessions WHERE token=?",[token]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/subscription/config",auth,async(req,res)=>{try{
 const fee=Math.max(0,Number(process.env.SUBSCRIPTION_FEE||0)), link=String(process.env.SUBSCRIPTION_PAYMENT_LINK||"").trim();
 const current=await one("SELECT id,status,amount,payment_method,reference,created_at,paid_at FROM subscriptions WHERE admin_id=? ORDER BY id DESC LIMIT 1",[req.admin.id]);
 res.json({fee,paymentLink:link,current});
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/subscription/request",auth,async(req,res)=>{try{
 const method=String(req.body.paymentMethod||"").trim().toUpperCase(), reference=String(req.body.reference||"").trim();
 if(!["TELEBIRR","BANK","MASTERCARD"].includes(method))return res.status(400).json({error:"Choose Telebirr, Bank transfer, or Mastercard."});
 const fee=Math.max(0,Number(process.env.SUBSCRIPTION_FEE||0));
 if(fee<=0)return res.status(400).json({error:"Main Admin has not configured the subscription fee yet."});
 const existing=await one("SELECT id,status FROM subscriptions WHERE admin_id=? ORDER BY id DESC LIMIT 1",[req.admin.id]);
 if(existing && String(existing.status).toUpperCase()==="PENDING")return res.status(409).json({error:"You already have a pending subscription payment."});
 let id;
 if(usePg){const r=await pgPool.query("INSERT INTO subscriptions(admin_id,store_id,amount,payment_method,reference,status) VALUES($1,$2,$3,$4,$5,'PENDING') RETURNING id",[req.admin.id,req.admin.store_id,fee,method,reference]);id=r.rows[0].id;}else{id=db.prepare("INSERT INTO subscriptions(admin_id,store_id,amount,payment_method,reference,status) VALUES(?,?,?,?,?,?)").run(req.admin.id,req.admin.store_id,fee,method,reference,"PENDING").lastInsertRowid;}
 res.json({ok:true,id,status:"PENDING",message:"Payment submitted for Main Admin verification."});
}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/main-admin/subscriptions",auth,async(req,res)=>{try{if(Number(req.admin.is_main_admin)!==1)return res.status(403).json({error:"Main Admin access required."});const r=await q("SELECT x.*,a.username,a.full_name,s.name AS store_name FROM subscriptions x JOIN admins a ON a.id=x.admin_id JOIN stores s ON s.id=x.store_id ORDER BY x.created_at DESC,x.id DESC");res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/main-admin/subscriptions/:id",auth,async(req,res)=>{try{if(Number(req.admin.is_main_admin)!==1)return res.status(403).json({error:"Main Admin access required."});const status=String(req.body.status||"").toUpperCase();if(!["PAID","REJECTED","PENDING"].includes(status))return res.status(400).json({error:"Invalid subscription status."});await run("UPDATE subscriptions SET status=?,paid_at=? WHERE id=?",[status,status==="PAID"?new Date().toISOString():null,req.params.id]);res.json({ok:true,status})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/products",async(req,res)=>{try{
 const slug=String(req.query.store||req.headers["x-store-slug"]||"").trim();
 let r;
 if(slug){
  r=await q("SELECT p.*,s.name AS store_name,s.slug AS store_slug FROM products p JOIN stores s ON s.id=p.store_id WHERE s.slug=? AND EXISTS (SELECT 1 FROM admins a WHERE a.store_id=s.id AND a.is_active=1) ORDER BY p.id DESC",[slug]);
 }else{
  r=await q("SELECT p.*,s.name AS store_name,s.slug AS store_slug FROM products p JOIN stores s ON s.id=p.store_id WHERE EXISTS (SELECT 1 FROM admins a WHERE a.store_id=s.id AND a.is_active=1) ORDER BY p.id DESC",[]);
 }
 res.json(r.rows);
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/products",auth,upload.any(),async(req,res)=>{
 try{
  const p=req.body; const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."}); if(!p.name||p.price===undefined)return res.status(400).json({error:"Name and price are required"});
  const files=Array.isArray(req.files)?req.files:[];
  const mainFile=files.find(f=>f.fieldname==="image");
  const image=await imgUrl(req,mainFile);
  const sizes=String(p.sizes||"").split(",").map(x=>x.trim()).filter(Boolean);
  const colors=[...new Set(String(p.colors||"").split(",").map(x=>x.trim()).filter(Boolean))];
  let sizeStock={}; try{sizeStock=JSON.parse(p.size_stock||"{}")}catch(e){}
  const normalized={}; for(const z of sizes){const n=Number(sizeStock[z]||0); normalized[z]=Number.isFinite(n)?Math.max(0,n):0;}
  let colorStock={}; try{colorStock=JSON.parse(p.color_stock||"{}")}catch(e){} const normalizedColors={}; for(const c of colors){const n=Number(colorStock[c]||0); normalizedColors[c]=Number.isFinite(n)?Math.max(0,n):0;}
  const colorImages={};
  for(const f of files.filter(f=>/^color_image_\d+$/.test(f.fieldname))){const m=f.fieldname.match(/^(?:color_image_)(\d+)$/);const idx=Number(m[1]);if(colors[idx])colorImages[colors[idx]]=await imgUrl(req,f);}
  const stock=Object.values(normalized).reduce((a,b)=>a+b,0);
  if(!sizes.length || stock<1)return res.status(400).json({error:"Add at least one size and a quantity for that size."});
  const vals=[store.id,p.name,p.brand||"",+p.price,+p.old_price||null,sizes.join(","),stock,JSON.stringify(normalized),colors.join(","),JSON.stringify(normalizedColors),JSON.stringify(colorImages),p.category||"Shoes",image];
  if(usePg){const r=await pgPool.query("INSERT INTO products(store_id,name,brand,price,old_price,sizes,stock,size_stock,colors,color_stock,color_images,category,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",vals);return res.json({id:r.rows[0].id});}
  const r=db.prepare("INSERT INTO products(store_id,name,brand,price,old_price,sizes,stock,size_stock,colors,color_stock,color_images,category,image) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...vals);res.json({id:r.lastInsertRowid});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/products/:id",auth,upload.any(),async(req,res)=>{
 try{
  const store=await getAdminStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const old=await one("SELECT * FROM products WHERE id=? AND store_id=?",[req.params.id,store.id]);if(!old)return res.sendStatus(404);
  const p=req.body,files=Array.isArray(req.files)?req.files:[],mainFile=files.find(f=>f.fieldname==="image");
  const image=mainFile?await imgUrl(req,mainFile):old.image;
  const sizes=String(p.sizes||"").split(",").map(x=>x.trim()).filter(Boolean);
  const colors=[...new Set(String(p.colors||"").split(",").map(x=>x.trim()).filter(Boolean))];
  let sizeStock={}; try{sizeStock=JSON.parse(p.size_stock||"{}")}catch(e){}
  let colorStock={}; try{colorStock=JSON.parse(p.color_stock||"{}")}catch(e){}
  let oldColorImages={}; try{oldColorImages=JSON.parse(old.color_images||"{}")}catch(e){}
  const normalized={}; for(const z of sizes){normalized[z]=Math.max(0,Number(sizeStock[z]||0));}
  const normalizedColors={}; for(const c of colors){const n=Number(colorStock[c]||0); normalizedColors[c]=Number.isFinite(n)?Math.max(0,n):0;}
  const colorImages={};
  for(const c of colors) if(oldColorImages[c]) colorImages[c]=oldColorImages[c];
  for(const f of files.filter(f=>/^color_image_\d+$/.test(f.fieldname))){const m=f.fieldname.match(/^(?:color_image_)(\d+)$/);const idx=Number(m[1]);if(colors[idx])colorImages[colors[idx]]=await imgUrl(req,f);}
  const stock=Object.values(normalized).reduce((a,b)=>a+b,0);
  await run("UPDATE products SET name=?,brand=?,price=?,old_price=?,sizes=?,stock=?,size_stock=?,colors=?,color_stock=?,color_images=?,category=?,image=? WHERE id=? AND store_id=?",[p.name,p.brand||"",+p.price,+p.old_price||null,sizes.join(","),stock,JSON.stringify(normalized),colors.join(","),JSON.stringify(normalizedColors),JSON.stringify(colorImages),p.category||"Shoes",image,req.params.id,store.id]);res.sendStatus(204);
 }catch(e){res.status(500).json({error:e.message})}
});
app.delete("/api/products/:id",auth,async(req,res)=>{const store=await getAdminStore(req);if(!store)return res.status(404).json({error:"Store not found."});await run("DELETE FROM products WHERE id=? AND store_id=?",[req.params.id,store.id]);res.sendStatus(204)});

app.post("/api/orders",async(req,res)=>{
 try{
  const {customer,phone,address,notes,items}=req.body;
  const store=await getPublicStore(req); if(!store)return res.status(404).json({error:"Store not found."});
  const signedCustomer=await getCustomer(req);
  const customerId=signedCustomer?signedCustomer.id:null;
  const paymentMethod=String(req.body.paymentMethod||"NONE").toUpperCase();
  const allowedPayments=["NONE","MASTERCARD","TELEBIRR","BANK"];
  if(!allowedPayments.includes(paymentMethod))return res.status(400).json({error:"Invalid payment method."});
  if(paymentMethod!=="NONE")return res.status(402).json({error:"This order can only be created after verified payment. The live gateway confirmation is not connected yet. Choose Pay later to place the order without payment."});
  if(!customer||!phone||!address||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Please complete your name, phone, address and cart."});
  const deliverySetting={value:await getSetting(store.id,"delivery_fee","0")};
  const deliveryFee=Math.max(0,Number(deliverySetting&&deliverySetting.value||0));
  const enteredCoupon=String(req.body.couponCode||"").trim().toUpperCase();
  const couponCodeRow={value:await getSetting(store.id,"coupon_code","")};
  const couponPercentRow={value:await getSetting(store.id,"coupon_percent","0")};
  const configuredCoupon=String(couponCodeRow&&couponCodeRow.value||"").trim().toUpperCase();
  const configuredPercent=Math.min(100,Math.max(0,Number(couponPercentRow&&couponPercentRow.value||0)));
  const couponApplied=Boolean(enteredCoupon && configuredCoupon && enteredCoupon===configuredCoupon && configuredPercent>0);
  if(enteredCoupon && !couponApplied)return res.status(400).json({error:"Invalid or expired discount coupon."});
  let subtotal=0;
  for(const i of items){
   const p=await one("SELECT price FROM products WHERE id=? AND store_id=?",[i.id,store.id]);
   if(!p)return res.status(409).json({error:"A product in your cart is no longer available."});
   subtotal += Number(p.price||0)*Number(i.qty||0);
  }
  const discount=couponApplied?subtotal*(configuredPercent/100):0;
  const total=Math.max(0,subtotal-discount+deliveryFee);
  for(const i of items){
   const p=await one("SELECT stock,name,price,size_stock,colors,color_stock FROM products WHERE id=? AND store_id=?",[i.id,store.id]);
   if(!p)return res.status(409).json({error:"A product in your cart is no longer available."});
   let ss={}; try{ss=JSON.parse(p.size_stock||"{}")}catch(e){}
   const size=String(i.size||"").trim(), available=Object.prototype.hasOwnProperty.call(ss,size)?Number(ss[size]):0;
   let cs={}; try{cs=JSON.parse(p.color_stock||"{}")}catch(e){}
   const color=String(i.color||"").trim(), colorList=String(p.colors||"").split(",").map(x=>x.trim()).filter(Boolean), colorAvailable=colorList.length?(Object.prototype.hasOwnProperty.call(cs,color)?Number(cs[color]):0):Infinity;
   if(!size || available<Number(i.qty))return res.status(409).json({error:`Not enough stock for ${p.name} in size ${size||"selected size"}. Only ${Math.max(0,available)} available.`});
   if(colorList.length && (!color || colorAvailable<Number(i.qty)))return res.status(409).json({error:`Not enough stock for ${p.name} in color ${color||"selected color"}. Only ${Math.max(0,colorAvailable)} available.`});
  }
  let orderId;
  if(usePg){const r=await pgPool.query("INSERT INTO orders(store_id,customer,phone,address,customer_id,notes,items,total,payment_method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",[store.id,customer,phone,address,customerId,notes||"",JSON.stringify(items),total,paymentMethod]);orderId=r.rows[0].id}
  else orderId=db.prepare("INSERT INTO orders(store_id,customer,phone,address,customer_id,notes,items,total,payment_method) VALUES(?,?,?,?,?,?,?,?,?)").run(store.id,customer,phone,address,customerId,notes||"",JSON.stringify(items),total,paymentMethod).lastInsertRowid;
  const smsItems=items.map(i=>`${i.qty}x ${i.name||"shoe"} (size ${i.size||"-"}${i.color?`, ${i.color}`:""})`).join("; ");
  const smsText=`NEW ${store.name} ORDER #${orderId}. Customer: ${customer}. Phone: ${phone}. Total: ${total.toFixed(2)} ${CURRENCY}. Items: ${smsItems}. Check Admin dashboard.`;
  // SMS is a notification only: if the provider is temporarily unavailable, the customer's order still succeeds.
  const storeAdmin=await one("SELECT phone FROM admins WHERE store_id=? AND phone<>? ORDER BY id ASC LIMIT 1",[store.id,""]);
  await sendAdminSMS(smsText,storeAdmin?.phone||SMS_ADMIN_PHONE);

  let wa="";
  if(WHATSAPP){
   const lines=items.map(i=>`${i.qty}x ${i.name||"shoe"} size ${i.size||""}${i.color?` color ${i.color}`:""}`).join("\n");
   wa=`https://wa.me/${(await getSetting(store.id,"whatsapp",WHATSAPP)).replace(/\D/g,"")}?text=${encodeURIComponent(`Hello ${store.name}, I placed order #${orderId}.\nName: ${customer}\nPhone: ${phone}\nAddress: ${address}\nItems:\n${lines}\nSubtotal: ${subtotal.toFixed(2)} ${CURRENCY}${couponApplied?`\nCoupon: ${configuredCoupon} (-${configuredPercent}%)\nDiscount: ${discount.toFixed(2)} ${CURRENCY}`:""}\nDelivery: ${deliveryFee.toFixed(2)} ${CURRENCY}\nTotal: ${total.toFixed(2)} ${CURRENCY}`)}`;
  }
  let paymentUrl="";
  if(paymentMethod==="MASTERCARD"){paymentUrl=await getSetting(store.id,"payment_mastercard_link","");}
  res.json({orderId,whatsapp:wa,subtotal,discount,couponCode:couponApplied?configuredCoupon:"",couponPercent:couponApplied?configuredPercent:0,deliveryFee,total,paymentMethod,paymentUrl});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/customer/orders",async(req,res)=>{
 try{
  const c=await getCustomer(req);if(!c)return res.status(401).json({error:"Not signed in."});
  const slug=String(req.query.store||req.headers["x-store-slug"]||"").trim();
  let r;
  if(slug){
   const store=await getPublicStore(req); if(!store)return res.status(404).json({error:"Store not found."});
   r=await q("SELECT o.id,o.total,o.status,o.created_at,o.items,o.payment_method,s.name AS store_name,s.slug AS store_slug FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.customer_id=? AND o.store_id=? ORDER BY o.created_at DESC,o.id DESC",[c.id,store.id]);
  }else{
   r=await q("SELECT o.id,o.total,o.status,o.created_at,o.items,o.payment_method,s.name AS store_name,s.slug AS store_slug FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.customer_id=? ORDER BY o.created_at DESC,o.id DESC",[c.id]);
  }
  res.json(r.rows);
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/orders/notification-count",auth,async(req,res)=>{try{let r=await q("SELECT COUNT(*) AS n FROM orders WHERE store_id=? AND status=? AND admin_seen=0",[req.admin.store_id,"NEW"]);res.json({count:Number(r.rows[0].n||0)})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/orders",auth,async(req,res)=>{try{let r=await q("SELECT * FROM orders WHERE store_id=? ORDER BY id DESC",[req.admin.store_id]);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/orders/mark-seen",auth,async(req,res)=>{try{await run("UPDATE orders SET admin_seen=1 WHERE store_id=? AND status=? AND admin_seen=0",[req.admin.store_id,"NEW"]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/orders/:id",auth,async(req,res)=>{
 try{
  const next=String(req.body.status||"").toUpperCase();
  const order=await one("SELECT id,status,items FROM orders WHERE id=? AND store_id=?",[req.params.id,req.admin.store_id]);
  if(!order)return res.status(404).json({error:"Order not found."});
  const current=String(order.status||"NEW").toUpperCase();
  if(next==="CONFIRMED" && current!=="CONFIRMED"){
   let items=[]; try{items=JSON.parse(order.items||"[]")}catch(e){}
   if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"This order has no items."});
   // Check every requested size again at confirmation time. Stock is reserved/decremented only here.
   for(const i of items){
    const p=await one("SELECT name,size_stock,colors,color_stock FROM products WHERE id=? AND store_id=?",[i.id,req.admin.store_id]);
    if(!p)return res.status(409).json({error:`Product #${i.id} is no longer available.`});
    let ss={}; try{ss=JSON.parse(p.size_stock||"{}")}catch(e){}
    const size=String(i.size||"").trim(), available=Number(ss[size]||0), wanted=Number(i.qty||0);
    let cs={}; try{cs=JSON.parse(p.color_stock||"{}")}catch(e){} const color=String(i.color||"").trim(), colorList=String(p.colors||"").split(",").map(x=>x.trim()).filter(Boolean), colorAvailable=colorList.length?(Number(cs[color]||0)):Infinity;
    if(!size || wanted<1 || available<wanted)return res.status(409).json({error:`Cannot confirm: ${p.name} size ${size||"selected size"} has only ${Math.max(0,available)} available.`});
    if(colorList.length && (!color || colorAvailable<wanted)){}
    if(colorList.length && (!color || colorAvailable<wanted))return res.status(409).json({error:`Cannot confirm: ${p.name} color ${color||"selected color"} has only ${Math.max(0,colorAvailable)} available.`});
   }
   for(const i of items){
    const p=await one("SELECT size_stock,color_stock FROM products WHERE id=? AND store_id=?",[i.id,req.admin.store_id]); let ss={}; try{ss=JSON.parse(p.size_stock||"{}")}catch(e){} let cs={}; try{cs=JSON.parse(p.color_stock||"{}")}catch(e){}
    ss[i.size]=Math.max(0,Number(ss[i.size]||0)-Number(i.qty));
    if(i.color && Object.prototype.hasOwnProperty.call(cs,i.color)) cs[i.color]=Math.max(0,Number(cs[i.color]||0)-Number(i.qty));
    const remaining=Object.values(ss).reduce((a,b)=>a+Number(b||0),0);
    await run("UPDATE products SET stock=?,size_stock=?,color_stock=? WHERE id=? AND store_id=?",[remaining,JSON.stringify(ss),JSON.stringify(cs),i.id,req.admin.store_id]);
   }
  }
  if(next==="DELIVERED" && current!=="CONFIRMED" && current!=="DELIVERED")return res.status(400).json({error:"Confirm the order before marking it delivered."});
  await run("UPDATE orders SET status=? WHERE id=?",[next,req.params.id]);
  res.json({ok:true,status:next});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/health",async(req,res)=>{try{await one("SELECT 1 AS ok");res.json({ok:true,db:usePg?"postgres":"sqlite"})}catch(e){res.status(500).json({ok:false,error:e.message})}});

initDb()
 .then(()=>migrateLocalImagesToDatabase())
 .then(()=>app.listen(PORT,()=>console.log(`${STORE_NAME} running on ${PORT}`)))
 .catch(e=>{console.error(e);process.exit(1)});
