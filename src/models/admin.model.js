const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // telegram user id
  username: String,
  role: { type: String, enum: ['admin', 'super_admin'], default: 'admin' },
});

module.exports = mongoose.model('Admin', AdminSchema);
