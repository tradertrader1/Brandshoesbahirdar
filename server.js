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
const STORE_NAME=process.env.STORE_NAME||"BRAND SHOES BAHIRDAR";
const CURRENCY=process.env.CURRENCY||"ETB";
const WHATSAPP=String(process.env.WHATSAPP_NUMBER||"251945306592").replace(/\D/g,"");
const ADMIN_USER=process.env.ADMIN_USER||"admin";
const ADMIN_PASS=process.env.ADMIN_PASS||"change-this-password";

const usePg=!!process.env.DATABASE_URL;
let db, pgPool;

const schema=`
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 name TEXT NOT NULL, brand TEXT DEFAULT '', price REAL NOT NULL,
 old_price REAL, sizes TEXT DEFAULT '', stock INTEGER NOT NULL DEFAULT 0,
 category TEXT DEFAULT 'Shoes', image TEXT DEFAULT '',
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 customer TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
 notes TEXT DEFAULT '', items TEXT NOT NULL, total REAL NOT NULL,
 status TEXT DEFAULT 'NEW', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

if(usePg){
  pgPool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes("localhost")?false:{rejectUnauthorized:false}});
}else{
  db=new Database(path.join(__dirname,"store.db"));
  db.pragma("journal_mode=WAL");
}

async function initDb(){
 if(usePg){ await pgPool.query(schema); }
 else { db.exec(schema.replace(/INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY/g,"INTEGER PRIMARY KEY AUTOINCREMENT")); }
 const count=await q("SELECT COUNT(*) AS n FROM products");
 if(Number(count.rows?count.rows[0].n:count[0].n)===0){
  const demo=[
   ["Nike Air Force 1 White","Nike",1200,1400,"39,40,41,42,43",5,"Air Force 1",""],
   ["Nike Air Force 1 Black","Nike",1250,1450,"39,40,41,42,43",5,"Air Force 1",""],
   ["Nike Air Force 1 White/Black","Nike",1300,1500,"40,41,42,43,44",4,"Air Force 1",""],
   ["Nike Air Force 1 Triple White","Nike",1350,1550,"39,40,41,42,43,44",3,"Air Force 1",""],
   ["Nike Air Force 1 Black/White","Nike",1280,1480,"40,41,42,43",4,"Air Force 1",""]
  ];
  for(const p of demo) await q(`INSERT INTO products(name,brand,price,old_price,sizes,stock,category,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,p);
 }
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
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:6*1024*1024}});

app.use(express.json({limit:"1mb"}));
app.use("/uploads",express.static(uploadsDir));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

function auth(req,res,next){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Basic ")) return res.status(401).set("WWW-Authenticate",'Basic realm="Store Admin"').end();
 const raw=Buffer.from(h.slice(6),"base64").toString();
 const pos=raw.indexOf(":"); const u=pos>=0?raw.slice(0,pos):raw,p=pos>=0?raw.slice(pos+1):"";
 if(u!==ADMIN_USER||p!==ADMIN_PASS)return res.status(403).json({error:"Invalid admin credentials"});
 next();
}
function imgUrl(req,file){
 if(!file)return "";
 if(process.env.CLOUDINARY_CLOUD_NAME){
  return new Promise((resolve,reject)=>{
   const stream=cloudinary.uploader.upload_stream({folder:"brand-shoes"},(err,result)=>err?reject(err):resolve(result.secure_url));
   stream.end(file.buffer);
  });
 }
 const name=Date.now()+"-"+crypto.randomBytes(4).toString("hex")+"-"+file.originalname.replace(/[^a-zA-Z0-9._-]/g,"");
 fs.writeFileSync(path.join(uploadsDir,name),file.buffer);
 return "/uploads/"+name;
}

app.get("/api/config",(req,res)=>res.json({storeName:STORE_NAME,currency:CURRENCY,whatsapp:WHATSAPP}));
app.get("/api/products",async(req,res)=>{try{let r=await q("SELECT * FROM products ORDER BY id DESC");res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/products",auth,upload.single("image"),async(req,res)=>{
 try{
  const p=req.body;if(!p.name||p.price===undefined)return res.status(400).json({error:"Name and price are required"});
  const image=await imgUrl(req,req.file);
  if(usePg){const r=await pgPool.query("INSERT INTO products(name,brand,price,old_price,sizes,stock,category,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",[p.name,p.brand||"",+p.price,+p.old_price||null,p.sizes||"",+p.stock||0,p.category||"Shoes",image]);return res.json({id:r.rows[0].id})}
  const r=db.prepare("INSERT INTO products(name,brand,price,old_price,sizes,stock,category,image) VALUES(?,?,?,?,?,?,?,?)").run(p.name,p.brand||"",+p.price,+p.old_price||null,p.sizes||"",+p.stock||0,p.category||"Shoes",image);res.json({id:r.lastInsertRowid});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/products/:id",auth,upload.single("image"),async(req,res)=>{
 try{
  const old=await one("SELECT * FROM products WHERE id=?",[req.params.id]);if(!old)return res.sendStatus(404);
  const p=req.body,image=req.file?await imgUrl(req,req.file):old.image;
  await run("UPDATE products SET name=?,brand=?,price=?,old_price=?,sizes=?,stock=?,category=?,image=? WHERE id=?",[p.name,p.brand||"",+p.price,+p.old_price||null,p.sizes||"",+p.stock||0,p.category||"Shoes",image,req.params.id]);res.sendStatus(204);
 }catch(e){res.status(500).json({error:e.message})}
});
app.delete("/api/products/:id",auth,async(req,res)=>{await run("DELETE FROM products WHERE id=?",[req.params.id]);res.sendStatus(204)});

app.post("/api/orders",async(req,res)=>{
 try{
  const {customer,phone,address,notes,items,total}=req.body;
  if(!customer||!phone||!address||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Please complete your name, phone, address and cart."});
  for(const i of items){const p=await one("SELECT stock,name,price FROM products WHERE id=?",[i.id]);if(!p||Number(p.stock)<Number(i.qty))return res.status(409).json({error:`Not enough stock for ${p?p.name:"a product"}.`})}
  for(const i of items)await run("UPDATE products SET stock=stock-? WHERE id=?",[Number(i.qty),i.id]);
  let orderId;
  if(usePg){const r=await pgPool.query("INSERT INTO orders(customer,phone,address,notes,items,total) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[customer,phone,address,notes||"",JSON.stringify(items),Number(total)||0]);orderId=r.rows[0].id}
  else orderId=db.prepare("INSERT INTO orders(customer,phone,address,notes,items,total) VALUES(?,?,?,?,?,?)").run(customer,phone,address,notes||"",JSON.stringify(items),Number(total)||0).lastInsertRowid;
  let wa="";
  if(WHATSAPP){
   const lines=items.map(i=>`${i.qty}x ${i.name||"shoe"} size ${i.size||""}`).join("\n");
   wa=`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Hello ${STORE_NAME}, I placed order #${orderId}.\\nName: ${customer}\\nPhone: ${phone}\\nAddress: ${address}\\nItems:\\n${lines}\\nTotal: ${CURRENCY} ${Number(total).toFixed(2)}`)}`;
  }
  res.json({orderId,whatsapp:wa});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/orders",auth,async(req,res)=>{try{let r=await q("SELECT * FROM orders ORDER BY id DESC");res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/orders/:id",auth,async(req,res)=>{await run("UPDATE orders SET status=? WHERE id=?",[req.body.status,req.params.id]);res.sendStatus(204)});

app.get("/api/health",async(req,res)=>{try{await one("SELECT 1 AS ok");res.json({ok:true,db:usePg?"postgres":"sqlite"})}catch(e){res.status(500).json({ok:false,error:e.message})}});

initDb().then(()=>app.listen(PORT,()=>console.log(`${STORE_NAME} running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
