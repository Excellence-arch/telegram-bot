require('dotenv').config();
const connectDB = require('./config/db');
const app = require('./app');

// start bot
require('./bot/bot');

connectDB();

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
