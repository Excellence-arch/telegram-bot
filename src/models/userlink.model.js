const mongoose = require('mongoose');

const UserLinkSchema = new mongoose.Schema({
  contestId: { type: mongoose.Types.ObjectId, required: true },
  userId: { type: String, required: true },
  username: String,
  link: { type: String, required: true },
  messageId: Number,
  timestamp: Date,
  createdAt: { type: Date, default: Date.now },
});

UserLinkSchema.index({ contestId: 1, userId: 1, link: 1 }, { unique: true });

module.exports = mongoose.model('UserLink', UserLinkSchema);
