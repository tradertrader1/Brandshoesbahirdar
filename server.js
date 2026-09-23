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
 old_price REAL, sizes TEXT DEFAULT '', stock INTEGER NOT NULL DEFAULT 0, size_stock TEXT DEFAULT '{}',
 category TEXT DEFAULT 'Shoes', image TEXT DEFAULT '',
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY ${usePg?"GENERATED ALWAYS AS IDENTITY":""},
 customer TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
 notes TEXT DEFAULT '', items TEXT NOT NULL, total REAL NOT NULL,
 status TEXT DEFAULT 'NEW', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings(
 key TEXT PRIMARY KEY, value TEXT NOT NULL
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
 // Per-size inventory migration for existing stores.
 try {
  if(usePg) await pgPool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS size_stock TEXT DEFAULT '{}'");
  else { try { db.exec("ALTER TABLE products ADD COLUMN size_stock TEXT DEFAULT '{}'"); } catch(e) { if(!String(e.message).includes("duplicate column")) throw e; } }
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
   const vals=[...p.slice(0,5),p[5],JSON.stringify(sizeStock),p[6],p[7]];
   if(usePg) await pgPool.query(`INSERT INTO products(name,brand,price,old_price,sizes,stock,size_stock,category,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,vals);
   else db.prepare("INSERT INTO products(name,brand,price,old_price,sizes,stock,size_stock,category,image) VALUES(?,?,?,?,?,?,?,?,?)").run(...vals);
  }
 }
 const existingWhatsApp=await one("SELECT value FROM settings WHERE key=?",["whatsapp"]);
 if(!existingWhatsApp){
  await run("INSERT INTO settings(key,value) VALUES(?,?)",["whatsapp",WHATSAPP]);
 }
 const existingDelivery=await one("SELECT value FROM settings WHERE key=?",["delivery_fee"]);
 if(!existingDelivery){
  await run("INSERT INTO settings(key,value) VALUES(?,?)",["delivery_fee","0"]);
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

app.get("/api/config",async(req,res)=>{
 try{
  const w=await one("SELECT value FROM settings WHERE key=?",["whatsapp"]);
  const d=await one("SELECT value FROM settings WHERE key=?",["delivery_fee"]);
  res.json({storeName:STORE_NAME,currency:CURRENCY,whatsapp:(w&&w.value)||WHATSAPP,deliveryFee:Math.max(0,Number(d&&d.value||0))});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/settings/whatsapp",auth,async(req,res)=>{
 try{
  const number=String(req.body.whatsapp||"").replace(/\D/g,"");
  if(number.length<8 || number.length>15)return res.status(400).json({error:"Enter a valid WhatsApp number in international format, e.g. 251945306592."});
  const existing=await one("SELECT value FROM settings WHERE key=?",["whatsapp"]);
  if(existing) await run("UPDATE settings SET value=? WHERE key=?",[number,"whatsapp"]);
  else await run("INSERT INTO settings(key,value) VALUES(?,?)",["whatsapp",number]);
  res.json({ok:true,whatsapp:number});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/settings/delivery",auth,async(req,res)=>{
 try{
  const fee=Number(req.body.deliveryFee);
  if(!Number.isFinite(fee)||fee<0)return res.status(400).json({error:"Enter a valid delivery price of 0 or more."});
  const existing=await one("SELECT value FROM settings WHERE key=?",["delivery_fee"]);
  if(existing) await run("UPDATE settings SET value=? WHERE key=?",[String(fee),"delivery_fee"]);
  else await run("INSERT INTO settings(key,value) VALUES(?,?)",["delivery_fee",String(fee)]);
  res.json({ok:true,deliveryFee:fee});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/products",async(req,res)=>{try{let r=await q("SELECT * FROM products ORDER BY id DESC");res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/products",auth,upload.single("image"),async(req,res)=>{
 try{
  const p=req.body;if(!p.name||p.price===undefined)return res.status(400).json({error:"Name and price are required"});
  const image=await imgUrl(req,req.file);
  const sizes=String(p.sizes||"").split(",").map(x=>x.trim()).filter(Boolean);
  let sizeStock={}; try{sizeStock=JSON.parse(p.size_stock||"{}")}catch(e){}
  const normalized={}; for(const z of sizes){const n=Number(sizeStock[z]||0); normalized[z]=Number.isFinite(n)?Math.max(0,n):0;}
  const stock=Object.values(normalized).reduce((a,b)=>a+b,0);
  if(!sizes.length || stock<1)return res.status(400).json({error:"Add at least one size and a quantity for that size."});
  const vals=[p.name,p.brand||"",+p.price,+p.old_price||null,sizes.join(","),stock,JSON.stringify(normalized),p.category||"Shoes",image];
  if(usePg){const r=await pgPool.query("INSERT INTO products(name,brand,price,old_price,sizes,stock,size_stock,category,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",vals);return res.json({id:r.rows[0].id});}
  const r=db.prepare("INSERT INTO products(name,brand,price,old_price,sizes,stock,size_stock,category,image) VALUES(?,?,?,?,?,?,?,?,?)").run(...vals);res.json({id:r.lastInsertRowid});
 }catch(e){res.status(500).json({error:e.message})}
});
app.put("/api/products/:id",auth,upload.single("image"),async(req,res)=>{
 try{
  const old=await one("SELECT * FROM products WHERE id=?",[req.params.id]);if(!old)return res.sendStatus(404);
  const p=req.body,image=req.file?await imgUrl(req,req.file):old.image;
  const sizes=String(p.sizes||"").split(",").map(x=>x.trim()).filter(Boolean); let sizeStock={}; try{sizeStock=JSON.parse(p.size_stock||"{}")}catch(e){}
  const normalized={}; for(const z of sizes){normalized[z]=Math.max(0,Number(sizeStock[z]||0));}
  const stock=Object.values(normalized).reduce((a,b)=>a+b,0);
  await run("UPDATE products SET name=?,brand=?,price=?,old_price=?,sizes=?,stock=?,size_stock=?,category=?,image=? WHERE id=?",[p.name,p.brand||"",+p.price,+p.old_price||null,sizes.join(","),stock,JSON.stringify(normalized),p.category||"Shoes",image,req.params.id]);res.sendStatus(204);
 }catch(e){res.status(500).json({error:e.message})}
});
app.delete("/api/products/:id",auth,async(req,res)=>{await run("DELETE FROM products WHERE id=?",[req.params.id]);res.sendStatus(204)});

app.post("/api/orders",async(req,res)=>{
 try{
  const {customer,phone,address,notes,items}=req.body;
  if(!customer||!phone||!address||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Please complete your name, phone, address and cart."});
  const deliverySetting=await one("SELECT value FROM settings WHERE key=?",["delivery_fee"]);
  const deliveryFee=Math.max(0,Number(deliverySetting&&deliverySetting.value||0));
  let subtotal=0;
  for(const i of items){
   const p=await one("SELECT price FROM products WHERE id=?",[i.id]);
   if(!p)return res.status(409).json({error:"A product in your cart is no longer available."});
   subtotal += Number(p.price||0)*Number(i.qty||0);
  }
  const total=subtotal+deliveryFee;
  for(const i of items){
   const p=await one("SELECT stock,name,price,size_stock FROM products WHERE id=?",[i.id]);
   if(!p)return res.status(409).json({error:"A product in your cart is no longer available."});
   let ss={}; try{ss=JSON.parse(p.size_stock||"{}")}catch(e){}
   const size=String(i.size||"").trim(), available=Object.prototype.hasOwnProperty.call(ss,size)?Number(ss[size]):0;
   if(!size || available<Number(i.qty))return res.status(409).json({error:`Not enough stock for ${p.name} in size ${size||"selected size"}. Only ${Math.max(0,available)} available.`});
  }
  let orderId;
  if(usePg){const r=await pgPool.query("INSERT INTO orders(customer,phone,address,notes,items,total) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[customer,phone,address,notes||"",JSON.stringify(items),total]);orderId=r.rows[0].id}
  else orderId=db.prepare("INSERT INTO orders(customer,phone,address,notes,items,total) VALUES(?,?,?,?,?,?)").run(customer,phone,address,notes||"",JSON.stringify(items),total).lastInsertRowid;
  let wa="";
  if(WHATSAPP){
   const lines=items.map(i=>`${i.qty}x ${i.name||"shoe"} size ${i.size||""}`).join("\n");
   wa=`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Hello ${STORE_NAME}, I placed order #${orderId}.\\nName: ${customer}\\nPhone: ${phone}\\nAddress: ${address}\\nItems:\\n${lines}\\nSubtotal: ${CURRENCY} ${subtotal.toFixed(2)}\\nDelivery: ${CURRENCY} ${deliveryFee.toFixed(2)}\\nTotal: ${CURRENCY} ${total.toFixed(2)}`)}`;
  }
  res.json({orderId,whatsapp:wa,subtotal,deliveryFee,total});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/orders",auth,async(req,res)=>{try{let r=await q("SELECT * FROM orders ORDER BY id DESC");res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/orders/:id",auth,async(req,res)=>{
 try{
  const next=String(req.body.status||"").toUpperCase();
  const order=await one("SELECT id,status,items FROM orders WHERE id=?",[req.params.id]);
  if(!order)return res.status(404).json({error:"Order not found."});
  const current=String(order.status||"NEW").toUpperCase();
  if(next==="CONFIRMED" && current!=="CONFIRMED"){
   let items=[]; try{items=JSON.parse(order.items||"[]")}catch(e){}
   if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"This order has no items."});
   // Check every requested size again at confirmation time. Stock is reserved/decremented only here.
   for(const i of items){
    const p=await one("SELECT name,size_stock FROM products WHERE id=?",[i.id]);
    if(!p)return res.status(409).json({error:`Product #${i.id} is no longer available.`});
    let ss={}; try{ss=JSON.parse(p.size_stock||"{}")}catch(e){}
    const size=String(i.size||"").trim(), available=Number(ss[size]||0), wanted=Number(i.qty||0);
    if(!size || wanted<1 || available<wanted)return res.status(409).json({error:`Cannot confirm: ${p.name} size ${size||"selected size"} has only ${Math.max(0,available)} available.`});
   }
   for(const i of items){
    const p=await one("SELECT size_stock FROM products WHERE id=?",[i.id]); let ss={}; try{ss=JSON.parse(p.size_stock||"{}")}catch(e){}
    ss[i.size]=Math.max(0,Number(ss[i.size]||0)-Number(i.qty));
    const remaining=Object.values(ss).reduce((a,b)=>a+Number(b||0),0);
    await run("UPDATE products SET stock=?,size_stock=? WHERE id=?",[remaining,JSON.stringify(ss),i.id]);
   }
  }
  if(next==="DELIVERED" && current!=="CONFIRMED" && current!=="DELIVERED")return res.status(400).json({error:"Confirm the order before marking it delivered."});
  await run("UPDATE orders SET status=? WHERE id=?",[next,req.params.id]);
  res.json({ok:true,status:next});
 }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/health",async(req,res)=>{try{await one("SELECT 1 AS ok");res.json({ok:true,db:usePg?"postgres":"sqlite"})}catch(e){res.status(500).json({ok:false,error:e.message})}});

initDb().then(()=>app.listen(PORT,()=>console.log(`${STORE_NAME} running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
