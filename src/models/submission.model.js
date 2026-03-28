const mongoose = require('mongoose');

const SubmissionSchema = new mongoose.Schema({
  contestId: mongoose.Types.ObjectId,
  userId: String,
  username: String,

  fileId: String,
  fileUniqueId: String,
  imageHash: String,

  relevanceScore: Number,
  aiVerdict: String,
  aiAnalysis: Object,
});

SubmissionSchema.index({ contestId: 1, fileUniqueId: 1 }, { unique: true });

module.exports = mongoose.model('Submission', SubmissionSchema);
