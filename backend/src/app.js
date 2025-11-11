import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}



import express from "express";
 import {createServer} from "node:http";

//  import  Server  from "socket.io";

import mongoose from "mongoose";
import cors from "cors";
import userRoutes from "./routes/users.route.js"
import  {connectToSocket}  from "./controllers/socketManager.js";

const app=express();
const server=createServer(app);
const io=connectToSocket(server);

app.set("port",(process.env.PORT || 8000));
app.use(cors());
app.use(express.json({limit:"40kb"}));
app.use(express.urlencoded({limit:"40kb",extended:true}));

app.use("/api/v1/users",userRoutes);

const dburl=process.env.ATLASDB_URL;

let start=async()=>{
    app.set("mongo_user");
    const connectiondb=await mongoose.connect(dburl,{
        useNewUrlParser: true,
  useUnifiedTopology: true,
});
    console.log(`MONGO Connected DB Host:${connectiondb.connection.host}`);
server.listen(app.get("port"),()=>{
    console.log("LISTENING PORT 8000");
})
}
start();