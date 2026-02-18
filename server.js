const express = require('express');
const app = express();
const port = 5000;
const morgan = require('morgan')
const {readdirSync} = require('fs')
const core = require('cors')


// midleware
app.use(morgan('dev'))
app.use(express.json())
app.use(core())



app.get('/',(req,res)=>{
  res.send('Hello World')
})

readdirSync('./routes')
.map((c)=>app.use('/api',require('./routes/'+c)))






app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});