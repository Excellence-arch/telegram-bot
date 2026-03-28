const mongoose = require('mongoose');

const ScoreSchema = new mongoose.Schema({
  contestId: mongoose.Types.ObjectId,
  userId: String,
  username: String,
  linkScore: { type: Number, default: 0 },
  screenshotScore: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
});

module.exports = mongoose.model('Score', ScoreSchema);
