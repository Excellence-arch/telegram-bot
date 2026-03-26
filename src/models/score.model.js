const mongoose = require('mongoose');

const ScoreSchema = new mongoose.Schema({
  contestId: mongoose.Types.ObjectId,
  userId: String,
  username: String,
  totalScore: { type: Number, default: 0 },
});

module.exports = mongoose.model('Score', ScoreSchema);
