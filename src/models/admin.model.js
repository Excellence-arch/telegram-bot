const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
  userId: String, // telegram user id
  username: String,
});

module.exports = mongoose.model('Admin', AdminSchema);
