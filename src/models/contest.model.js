const mongoose = require('mongoose');

const ContestSchema = new mongoose.Schema({
  name: String,
  description: String,
  chatId: String,
  isActive: { type: Boolean, default: true },
});

module.exports = mongoose.model('Contest', ContestSchema);
