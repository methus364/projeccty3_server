const { prisma } = require("../config/prisma");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { emit } = require("nodemon");
exports.register = async (req, res) => {
  try {
    const { email, password, name } = req.body;
    //check email password
    console.log(email, password, name);
    if (!email) {
      return res.status(400).json({ message: "Email Is Required !!!" });
    }
    if (!password) {
      return res.status(400).json({ message: "Password Is Required !!!" });
    }
    //check data base
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: email }, { name: name }],
      },
    });
    if (user) {
      const isEmailDup = user.email === email;
      return res.status(400).json({
        message: isEmailDup ? "Email already exists" : "Name already exists",
      });
    }
    //HashPassword
    const HashPassword = await bcrypt.hash(password, 10);
    //register
    await prisma.user.create({
      data: {
        email: email,
        password: HashPassword,
        name: name,
      },
    });
    res.send("Register Success");
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "server error" });
  }
};

exports.login = async (req, res) => {
  try {
    //check email
    const { email, password } = req.body;
    console.log(email, password);
    const user = await prisma.user.findFirst({
      where: {
        email: email,
      },
    });
    if (!user || !user.enabled) {
      return res.status(400).json({ message: "Use not Found" });
    }
    //check
    const IsMach = await bcrypt.compare(password, user.password);
    if (!IsMach) {
      return res.status(401).json({ message: "Password Invalid!!!" });
    }
    //creat paylord
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    //gemnarate token
    jwt.sign(payload, process.env.SECRET, { expiresIn: "1d" }, (err, token) => {
      if (err) {
        console.log(err);
        return res.status(500).json({ message: "Server Error jwt" });
      }
      res.json({ payload, token });
      // console.log(payload,token)
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "server error" });
  }
};

exports.currentUser = async (req, res) => {
  try {
    const user = await prisma.user.findFirst({
      where: {
        email: req.user.email,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
    res.json({ user });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Server Error" });
  }
};
