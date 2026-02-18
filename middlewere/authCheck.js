const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

exports.authCheck = async (req, res, next) => {
  try {
    const headerToken = req.headers.authorization;
    if (!headerToken) {
      return res.status(401).json({ message: "No Token, Authorization" });
    }
    const token = headerToken.split(" ")[1];

    const decode = jwt.verify(token, process.env.SECRET);
    req.user = decode;

    const user = await prisma.user.findFirst({
      where: {
        email: req.user.email,
      },
    });
    if (!user.enabled) {
      return res.status(400).json({ message: "This accout cannot access" });
    }
    next();
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Token Invalid" });
  }
};

exports.subCheck = async (req, res, next) => {
  try {
    const {email} = req.user
    const subUser = await prisma.user.findFirst({
        where:{email:email}
    })
    
    if(!subUser || subUser.role.trim() !== "SUBSCRIPTION"){
       return res.status(403).json({message:"Acess Denied : SUBSCRIPTION Invalid"})  
    }
    next()
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error SUBSCRIPTION access denined" });
  }
};


exports.adminCheck = async (req, res, next) => {
  try {
    const {email} = req.user
    const adminUser = await prisma.user.findFirst({
        where:{email:email}
    })
    
    if(!adminUser || adminUser.role.trim() !== "ADMIN"){
       return res.status(403).json({message:"Acess Denied : Admin Invalid"})  
    }
    next()
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error Admin access denined" });
  }
};
