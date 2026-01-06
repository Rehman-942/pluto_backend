const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  videoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Video',
    required: [true, 'Video ID is required'],
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },
  content: {
    type: String,
    required: [true, 'Comment content is required'],
    trim: true,
    maxlength: [500, 'Comment cannot exceed 500 characters']
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    default: null,
    index: true
  },
  mentions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  thread: {
    level: {
      type: Number,
      default: 0,
      max: 5 // Limit nesting to 5 levels
    },
    path: {
      type: String,
      default: ''
    }
  },
  moderation: {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved'
    },
    flags: [{
      type: String,
      enum: ['spam', 'inappropriate', 'harassment', 'hate_speech', 'other']
    }],
    sentiment: {
      type: String,
      enum: ['positive', 'neutral', 'negative'],
      default: 'neutral'
    },
    toxicityScore: {
      type: Number,
      min: 0,
      max: 1,
      default: 0
    }
  },
  stats: {
    likesCount: {
      type: Number,
      default: 0
    },
    repliesCount: {
      type: Number,
      default: 0
    },
    reportsCount: {
      type: Number,
      default: 0
    }
  },
  likes: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  isEdited: {
    type: Boolean,
    default: false
  },
  editHistory: [{
    content: String,
    editedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for performance
commentSchema.index({ videoId: 1, createdAt: -1 });
commentSchema.index({ userId: 1, createdAt: -1 });
commentSchema.index({ parentId: 1 });
commentSchema.index({ 'moderation.status': 1 });
commentSchema.index({ 'stats.likesCount': -1 });

// Compound indexes
commentSchema.index({ videoId: 1, parentId: 1, createdAt: -1 });
commentSchema.index({ videoId: 1, 'moderation.status': 1, createdAt: -1 });

// Virtual for user info
commentSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true
});

// Virtual for replies
commentSchema.virtual('replies', {
  ref: 'Comment',
  localField: '_id',
  foreignField: 'parentId'
});

// Method to check if user liked the comment
commentSchema.methods.isLikedBy = function(userId) {
  return this.likes.some(like => like.userId.toString() === userId.toString());
};

// Method to add like
commentSchema.methods.addLike = function(userId) {
  if (!this.isLikedBy(userId)) {
    this.likes.push({ userId });
    this.stats.likesCount = this.likes.length;
  }
  return this.save();
};

// Method to remove like
commentSchema.methods.removeLike = function(userId) {
  this.likes = this.likes.filter(like => like.userId.toString() !== userId.toString());
  this.stats.likesCount = this.likes.length;
  return this.save();
};

// Pre-save middleware to update thread path
commentSchema.pre('save', async function(next) {
  if (this.isNew && this.parentId) {
    try {
      const parentComment = await this.constructor.findById(this.parentId);
      if (parentComment) {
        this.thread.level = parentComment.thread.level + 1;
        this.thread.path = parentComment.thread.path 
          ? `${parentComment.thread.path}/${this.parentId}` 
          : `/${this.parentId}`;
      }
    } catch (error) {
      return next(error);
    }
  }
  
  if (this.isModified('likes')) {
    this.stats.likesCount = this.likes.length;
  }
  
  next();
});

// Static method to get comments for a photo
commentSchema.statics.getPhotoComments = function(photoId, options = {}) {
  const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 1 } = options;
  
  return this.find({
    photoId,
    parentId: null, // Only get top-level comments
    'moderation.status': 'approved'
  })
  .populate('userId', 'username firstName lastName avatar')
  .populate({
    path: 'replies',
    match: { 'moderation.status': 'approved' },
    populate: {
      path: 'userId',
      select: 'username firstName lastName avatar'
    },
    options: { sort: { createdAt: 1 }, limit: 3 } // Only show first 3 replies
  })
  .sort({ [sortBy]: sortOrder })
  .limit(limit * 1)
  .skip((page - 1) * limit)
  .lean();
};

// Static method to get comment thread
commentSchema.statics.getCommentThread = function(commentId, options = {}) {
  const { limit = 50 } = options;
  
  return this.find({
    $or: [
      { _id: commentId },
      { 'thread.path': new RegExp(`/${commentId}(/|$)`) }
    ],
    'moderation.status': 'approved'
  })
  .populate('userId', 'username firstName lastName avatar')
  .sort({ 'thread.level': 1, createdAt: 1 })
  .limit(limit)
  .lean();
};

module.exports = mongoose.model('Comment', commentSchema);
