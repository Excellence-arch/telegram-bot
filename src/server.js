require('dotenv').config();
const connectDB = require('./config/db');
const app = require('./app');

// start bot
require('./bot/bot');

connectDB();

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});

// Admin = require('./models/admin.model');

// async function createDefaultAdmin() {
//   const newAdmin = new Admin({
//     userId: '1225158265',
//     username: '@the_oluwayimika',
//   }); // replace with your telegram user id
//   await newAdmin.save();
//   console.log('Default admin created:');
//   console.log(newAdmin);
// }

// createDefaultAdmin();
