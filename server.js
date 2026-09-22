const express=require("express");
const path=require("path"), fs=require("fs"), multer=require("multer");
const Database=require("better-sqlite3");

const app=express();
const PORT=process.env.PORT||3000;
const ADMIN_USER=process.env.ADMIN_USER||"admin";
const ADMIN_PASS=process.env.ADMIN_PASS||"change-me";

const db=new Database("store.db");
db.exec(`CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  price REAL NOT NULL,
  old_price REAL,
  sizes TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  image TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT,
  items TEXT NOT NULL,
  total REAL NOT NULL,
  status TEXT DEFAULT 'NEW',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

const uploadsDir=path.join(__dirname,"uploads");
fs.mkdirSync(uploadsDir,{recursive:true});

const demoCount=db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if(demoCount===0){
  const demo=[
    ["Nike Air Force 1 White","Nike Air Force 1",120,140,"39,40,41,42,43",5,"Air Force 1",""],
    ["Nike Air Force 1 Black","Nike Air Force 1",125,145,"39,40,41,42,43",5,"Air Force 1",""],
    ["Nike Air Force 1 White/Black","Nike Air Force 1",130,150,"40,41,42,43,44",4,"Air Force 1",""],
    ["Nike Air Force 1 Triple White","Nike Air Force 1",135,155,"39,40,41,42,43,44",3,"Air Force 1",""],
    ["Nike Air Force 1 Black/White","Nike Air Force 1",128,148,"40,41,42,43",4,"Air Force 1",""]
  ];
  const ins=db.prepare("INSERT INTO products(name,brand,price,old_price,sizes,stock,category,image) VALUES(?,?,?,?,?,?,?,?)");
  db.transaction(()=>demo.forEach(p=>ins.run(...p)))();
}

const upload=multer({
  storage:multer.diskStorage({
    destination:uploadsDir,
    filename:(r,f,cb)=>cb(null,Date.now()+"-"+f.originalname.replace(/[^a-zA-Z0-9._-]/g,""))
  }),
  limits:{fileSize:5*1024*1024}
});

app.use(express.json({limit:"1mb"}));
app.use("/uploads",express.static(uploadsDir));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

function auth(req,res,next){
  let h=req.headers.authorization||"";
  if(!h.startsWith("Basic ")) return res.status(401).set("WWW-Authenticate",'Basic realm="Store Admin"').end();
  let [u,p]=Buffer.from(h.slice(6),"base64").toString().split(":");
  if(u!==ADMIN_USER||p!==ADMIN_PASS) return res.status(403).json({error:"Invalid admin credentials"});
  next();
}

app.get("/api/products",(req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all()));

app.post("/api/products",auth,upload.single("image"),(req,res)=>{
  let p=req.body;
  if(!p.name||p.price===undefined) return res.status(400).json({error:"Name and price required"});
  let image=req.file?"/uploads/"+req.file.filename:"";
  let info=db.prepare("INSERT INTO products(name,brand,price,old_price,sizes,stock,category,image) VALUES(?,?,?,?,?,?,?,?)")
    .run(p.name,p.brand||"",+p.price,+p.old_price||null,p.sizes||"",+p.stock||0,p.category||"Shoes",image);
  res.json({id:info.lastInsertRowid});
});

app.put("/api/products/:id",auth,upload.single("image"),(req,res)=>{
  let old=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if(!old) return res.sendStatus(404);
  let p=req.body,image=req.file?"/uploads/"+req.file.filename:old.image;
  db.prepare("UPDATE products SET name=?,brand=?,price=?,old_price=?,sizes=?,stock=?,category=?,image=? WHERE id=?")
    .run(p.name,p.brand||"",+p.price,+p.old_price||null,p.sizes||"",+p.stock||0,p.category||"Shoes",image,req.params.id);
  res.sendStatus(204);
});

app.delete("/api/products/:id",auth,(req,res)=>{
  db.prepare("DELETE FROM products WHERE id=?").run(req.params.id);
  res.sendStatus(204);
});

app.post("/api/orders",(req,res)=>{
  let {customer,phone,address,notes,items,total}=req.body;
  if(!customer||!phone||!address||!Array.isArray(items)||!items.length)
    return res.status(400).json({error:"Missing order details"});
  const tx=db.transaction(()=>{
    for(const i of items){
      let p=db.prepare("SELECT stock FROM products WHERE id=?").get(i.id);
      if(!p||p.stock<i.qty) throw Error("Insufficient stock for product "+i.id);
    }
    for(const i of items) db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(i.qty,i.id);
    return db.prepare("INSERT INTO orders(customer,phone,address,notes,items,total) VALUES(?,?,?,?,?,?)")
      .run(customer,phone,address,notes||"",JSON.stringify(items),+total||0).lastInsertRowid;
  });
  try{res.json({orderId:tx()})}catch(e){res.status(409).json({error:e.message})}
});

app.get("/api/orders",auth,(req,res)=>res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC").all()));

app.patch("/api/orders/:id",auth,(req,res)=>{
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(req.body.status,req.params.id);
  res.sendStatus(204);
});

app.listen(PORT,()=>console.log("Store running on port "+PORT));
