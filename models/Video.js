const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Video title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  
  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },

  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Creator ID is required'],
    index: true
  },

  tags: [{
    type: String,
    trim: true,
    lowercase: true,
    maxlength: [30, 'Tag cannot exceed 30 characters']
  }],

  visibility: {
    type: String,
    enum: ['public', 'unlisted', 'private'],
    default: 'public',
    index: true
  },

  // Azure Storage video data
  video: {
    original: {
      url: { type: String, required: true },
      blobName: { type: String, required: true },
      duration: Number, // in seconds
      width: Number,
      height: Number,
      format: String,
      bytes: Number,
      frameRate: Number,
      bitRate: Number
    },
    // Different quality variants
    qualities: {
      hd: {
        url: String,
        blobName: String,
        width: Number,
        height: Number,
        bitRate: Number
      },
      sd: {
        url: String,
        blobName: String,
        width: Number,
        height: Number,
        bitRate: Number
      },
      mobile: {
        url: String,
        blobName: String,
        width: Number,
        height: Number,
        bitRate: Number
      }
    }
  },

  // Video thumbnails at different timestamps
  thumbnails: {
    poster: {
      url: String,
      blobName: String,
      width: Number,
      height: Number
    },
    timeline: [{
      url: String,
      blobName: String,
      timestamp: Number, // time in seconds
      width: Number,
      height: Number
    }],
    large: {
      url: String,
      blobName: String,
      width: Number,
      height: Number
    },
    medium: {
      url: String,
      blobName: String,
      width: Number,
      height: Number
    },
    small: {
      url: String,
      blobName: String,
      width: Number,
      height: Number
    }
  },

  metadata: {
    fileName: String,
    mimeType: String,
    codec: String,
    audioCodec: String,
    videoCodec: String,
    container: String,
    camera: {
      make: String,
      model: String,
      settings: {
        aperture: String,
        shutterSpeed: String,
        iso: Number,
        focalLength: String
      }
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        index: '2dsphere'
      },
      address: String,
      city: String,
      country: String
    },
    recordedAt: Date,
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    processedAt: Date,
    processingStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending'
    }
  },

  stats: {
    viewsCount: {
      type: Number,
      default: 0,
      index: true
    },
    likesCount: {
      type: Number,
      default: 0,
      index: true
    },
    commentsCount: {
      type: Number,
      default: 0
    },
    sharesCount: {
      type: Number,
      default: 0
    },
    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    ratingsCount: {
      type: Number,
      default: 0
    },
    saveCount: {
      type: Number,
      default: 0
    },
    watchTime: {
      total: { type: Number, default: 0 }, // total seconds watched
      average: { type: Number, default: 0 } // average watch time per view
    }
  },

  moderation: {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved'
    },
    reviewedAt: Date,
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    flags: [{
      type: String,
      enum: ['inappropriate', 'spam', 'copyright', 'violence', 'other']
    }],
    aiContentScore: {
      type: Number,
      min: 0,
      max: 1,
      default: 1
    }
  },

  featured: {
    type: Boolean,
    default: false,
    index: true
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

  views: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    ip: String,
    userAgent: String,
    watchTime: { type: Number, default: 0 }, // seconds watched
    viewedAt: {
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

// Indexes for performance optimization
videoSchema.index({ createdAt: -1 });
videoSchema.index({ creatorId: 1, createdAt: -1 });
videoSchema.index({ visibility: 1, createdAt: -1 });
videoSchema.index({ featured: 1, createdAt: -1 });
videoSchema.index({ tags: 1 });
videoSchema.index({ 'stats.viewsCount': -1 });
videoSchema.index({ 'stats.likesCount': -1 });
videoSchema.index({ 'stats.averageRating': -1 });
videoSchema.index({ 'moderation.status': 1 });
videoSchema.index({ 'video.original.duration': 1 });
videoSchema.index({ 'metadata.processingStatus': 1 });

// Compound indexes for complex queries
videoSchema.index({ visibility: 1, 'moderation.status': 1, createdAt: -1 });
videoSchema.index({ creatorId: 1, visibility: 1, createdAt: -1 });
videoSchema.index({ tags: 1, visibility: 1, createdAt: -1 });
videoSchema.index({ 'metadata.location': '2dsphere' });

// Text index for search
videoSchema.index({
  title: 'text',
  description: 'text',
  tags: 'text'
}, {
  weights: {
    title: 10,
    tags: 5,
    description: 1
  }
});

// Virtual for creator info (populated)
videoSchema.virtual('creator', {
  ref: 'User',
  localField: 'creatorId',
  foreignField: '_id',
  justOne: true
});

// Virtual for comments count
videoSchema.virtual('commentsVirtual', {
  ref: 'Comment',
  localField: '_id',
  foreignField: 'videoId',
  count: true
});

// Method to check if user liked the video
videoSchema.methods.isLikedBy = function(userId) {
  return this.likes.some(like => like.userId.toString() === userId.toString());
};

// Method to add like
videoSchema.methods.addLike = function(userId) {
  if (!this.isLikedBy(userId)) {
    this.likes.push({ userId });
    this.stats.likesCount = this.likes.length;
  }
  return this.save();
};

// Method to remove like
videoSchema.methods.removeLike = function(userId) {
  this.likes = this.likes.filter(like => like.userId.toString() !== userId.toString());
  this.stats.likesCount = this.likes.length;
  return this.save();
};

// Method to add view with watch time tracking
videoSchema.methods.addView = function(userId, ip, userAgent, watchTime = 0) {
  // Don't count multiple views from same user within 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existingView = this.views.find(view => 
    view.userId && view.userId.toString() === userId.toString() && 
    view.viewedAt > twentyFourHoursAgo
  );
  
  if (!existingView) {
    this.views.push({ userId, ip, userAgent, watchTime });
    this.stats.viewsCount = this.views.length;
    
    // Update watch time stats
    this.stats.watchTime.total += watchTime;
    this.stats.watchTime.average = this.stats.watchTime.total / this.stats.viewsCount;
    
    // Keep only last 1000 views for performance
    if (this.views.length > 1000) {
      this.views = this.views.slice(-1000);
    }
  }
  return this.save();
};

// Method to update watch time for existing view
videoSchema.methods.updateWatchTime = function(userId, additionalWatchTime) {
  const recentView = this.views.find(view => 
    view.userId && view.userId.toString() === userId.toString()
  );
  
  if (recentView) {
    recentView.watchTime += additionalWatchTime;
    this.stats.watchTime.total += additionalWatchTime;
    this.stats.watchTime.average = this.stats.watchTime.total / this.stats.viewsCount;
  }
  
  return this.save();
};

// Static method for video search
videoSchema.statics.searchVideos = function(query, options = {}) {
  const {
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = -1,
    tags,
    creatorId,
    featured,
    visibility = ['public'],
    minDuration,
    maxDuration
  } = options;
  
  let searchQuery = {
    visibility: { $in: visibility },
    'moderation.status': 'approved',
    'metadata.processingStatus': 'completed'
  };
  
  if (query && query.trim()) {
    searchQuery.$text = { $search: query };
  }
  
  if (tags && tags.length > 0) {
    searchQuery.tags = { $in: tags };
  }
  
  if (creatorId) {
    searchQuery.creatorId = creatorId;
  }
  
  if (featured !== undefined) {
    searchQuery.featured = featured;
  }
  
  if (minDuration || maxDuration) {
    searchQuery['video.original.duration'] = {};
    if (minDuration) searchQuery['video.original.duration'].$gte = minDuration;
    if (maxDuration) searchQuery['video.original.duration'].$lte = maxDuration;
  }
  
  const sortOptions = { [sortBy]: sortOrder };
  if (query && query.trim()) {
    sortOptions.score = { $meta: 'textScore' };
  }
  
  return this.find(searchQuery)
    .populate('creatorId', 'username firstName lastName avatar')
    .sort(sortOptions)
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .lean();
};

// Static method to get trending videos
videoSchema.statics.getTrendingVideos = function(options = {}) {
  const { page = 1, limit = 20, timeframe = '7d' } = options;
  
  let dateFilter;
  const now = new Date();
  
  switch (timeframe) {
    case '1d':
      dateFilter = new Date(now - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      dateFilter = new Date(now - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      dateFilter = new Date(now - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      dateFilter = new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
  
  return this.find({
    visibility: 'public',
    'moderation.status': 'approved',
    'metadata.processingStatus': 'completed',
    createdAt: { $gte: dateFilter }
  })
  .populate('creatorId', 'username firstName lastName avatar')
  .sort({
    'stats.likesCount': -1,
    'stats.viewsCount': -1,
    'stats.watchTime.average': -1,
    'stats.averageRating': -1
  })
  .limit(limit * 1)
  .skip((page - 1) * limit)
  .lean();
};

// Pre-save middleware to update stats
videoSchema.pre('save', function(next) {
  if (this.isModified('likes')) {
    this.stats.likesCount = this.likes.length;
  }
  if (this.isModified('views')) {
    this.stats.viewsCount = this.views.length;
  }
  next();
});

module.exports = mongoose.model('Video', videoSchema);
