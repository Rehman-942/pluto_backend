const express = require('express');
const multer = require('multer');
const { authenticateToken, requireRole } = require('../middleware/auth');
const Video = require('../models/Video');
const User = require('../models/User');
const videoProcessor = require('../utils/videoProcessor');
const Joi = require('joi');
const path = require('path');

const router = express.Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/temp/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'video-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    // Check if file is a video
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

// Validation schemas
const videoUploadSchema = Joi.object({
  title: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(1000).optional().allow(''),
  tags: Joi.array().items(Joi.string().max(30)).max(10).optional(),
  visibility: Joi.string().valid('public', 'unlisted', 'private').default('public')
});

const videoUpdateSchema = Joi.object({
  title: Joi.string().min(1).max(200).optional(),
  description: Joi.string().max(1000).optional().allow(''),
  tags: Joi.array().items(Joi.string().max(30)).max(10).optional(),
  visibility: Joi.string().valid('public', 'unlisted', 'private').optional()
});

// GET /api/videos - Get all videos with pagination and filters
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      tags,
      creatorId,
      featured,
      search,
      minDuration,
      maxDuration
    } = req.query;


    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      sortBy,
      sortOrder: sortOrder === 'asc' ? 1 : -1,
      visibility: ['public'],
      minDuration: minDuration ? parseInt(minDuration) : undefined,
      maxDuration: maxDuration ? parseInt(maxDuration) : undefined
    };

    if (tags) options.tags = tags.split(',');
    if (creatorId) options.creatorId = creatorId;
    if (featured) options.featured = featured === 'true';

    const videos = await Video.searchVideos(search, options);
    
    const response = {
      success: true,
      data: {
        videos,
        pagination: {
          page: options.page,
          limit: options.limit,
          hasMore: videos.length === options.limit
        }
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch videos'
    });
  }
});

// GET /api/videos/liked - Get user's liked videos
router.get('/liked', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100)
    };

    // Find videos that the user has liked
    const videos = await Video.find({
      'likes.userId': req.user._id,
      visibility: 'public'
    })
    .populate('creatorId', 'username firstName lastName avatar')
    .sort({ 'likes.createdAt': -1 }) // Sort by when user liked them
    .skip((options.page - 1) * options.limit)
    .limit(options.limit)
    .lean();

    // Add isLikedByUser field for consistency
    const videosWithLikeStatus = videos.map(video => ({
      ...video,
      isLikedByUser: true // Always true for liked videos
    }));
    
    const response = {
      success: true,
      data: {
        videos: videosWithLikeStatus,
        pagination: {
          page: options.page,
          limit: options.limit,
          hasMore: videos.length === options.limit
        }
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching liked videos:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch liked videos'
    });
  }
});

// GET /api/videos/trending - Get trending videos
router.get('/trending', async (req, res) => {
  try {
    const { page = 1, limit = 20, timeframe = '7d' } = req.query;
    

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      timeframe
    };

    const videos = await Video.getTrendingVideos(options);
    
    const response = {
      success: true,
      data: {
        videos,
        pagination: {
          page: options.page,
          limit: options.limit,
          hasMore: videos.length === options.limit
        }
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching trending videos:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trending videos'
    });
  }
});

// GET /api/videos/user/:userId - Get videos by user
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20, visibility = 'public' } = req.query;
    

    let visibilityArray = ['public'];
    
    // If authenticated user is viewing their own videos, include all visibility levels
    if (req.user && req.user._id.toString() === userId && visibility === 'all') {
      visibilityArray = ['public', 'unlisted', 'private'];
    }

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      creatorId: userId,
      visibility: visibilityArray
    };

    const videos = await Video.getUserVideos(userId, options);
    
    const response = {
      success: true,
      data: {
        videos,
        pagination: {
          page: options.page,
          limit: options.limit,
          hasMore: videos.length === options.limit
        }
      }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching user videos:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user videos'
    });
  }
});

// GET /api/videos/:id - Get single video
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    

    const video = await Video.findById(id)
      .populate('creatorId', 'username firstName lastName avatar')
      .lean();

    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    // Check if user has permission to view this video
    const canView = video.visibility === 'public' || 
                   (req.user && (
                     video.creatorId._id.toString() === req.user._id.toString() ||
                     req.user.role === 'Admin'
                   ));

    if (!canView) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to view this video'
      });
    }

    // Record view and check if user liked the video
    if (req.user) {
      try {
        const videoDoc = await Video.findById(id);
        await videoDoc.addView(req.user._id, req.ip, req.get('User-Agent'));
        video.stats.viewsCount = videoDoc.stats.viewsCount;
        
        // Add isLikedByUser field for authenticated users
        video.isLikedByUser = videoDoc.isLikedBy(req.user._id);
      } catch (viewError) {
        console.error('Error recording view:', viewError);
      }
    } else {
      // For non-authenticated users, set isLikedByUser to false
      video.isLikedByUser = false;
    }

    const response = {
      success: true,
      data: { video }
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch video'
    });
  }
});

// POST /api/videos - Upload new video (Creator only)
router.post('/', 
  authenticateToken, 
  requireRole(['Creator']),
  upload.single('video'),
  async (req, res) => {
    let tempVideoPath = null;
    
    try {
      // Validate request body
      const { error, value } = videoUploadSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: error.details[0].message
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Video file is required'
        });
      }

      tempVideoPath = req.file.path;
      
      // Generate unique public ID for video
      const videoPublicId = `video_${Date.now()}_${req.user._id}`;
      
      // Process video (generate thumbnails, upload to Cloudinary, etc.)
      console.log('Starting video processing...');
      const processingResult = await videoProcessor.processVideo(tempVideoPath, videoPublicId);
      
      // Create video document
      const videoData = {
        title: value.title,
        description: value.description || '',
        creatorId: req.user._id,
        tags: value.tags || [],
        visibility: value.visibility || 'public',
        video: processingResult.video,
        thumbnails: processingResult.thumbnails,
        metadata: {
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          ...processingResult.metadata
        }
      };

      const video = new Video(videoData);
      await video.save();

      // Update user's video count
      await User.findByIdAndUpdate(req.user._id, {
        $inc: { 'stats.videosCount': 1 }
      });

      // Populate creator info for response
      await video.populate('creatorId', 'username firstName lastName avatar');


      res.status(201).json({
        success: true,
        data: { video },
        message: 'Video uploaded successfully'
      });
    } catch (error) {
      console.error('Error uploading video:', error);
      
      // Clean up temp file on error
      if (tempVideoPath) {
        videoProcessor.cleanupFile(tempVideoPath);
      }
      
      res.status(500).json({
        success: false,
        error: 'Failed to upload video'
      });
    }
  }
);

// PUT /api/videos/:id - Update video (Creator/Admin only)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate request body
    const { error, value } = videoUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const video = await Video.findById(id);
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    // Check permissions
    const canEdit = video.creatorId.toString() === req.user._id.toString() || 
                   req.user.role === 'Admin';
    
    if (!canEdit) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to edit this video'
      });
    }

    // Update video
    Object.assign(video, value);
    video.updatedAt = new Date();
    await video.save();

    // Populate creator info
    await video.populate('creatorId', 'username firstName lastName avatar');

    res.json({
      success: true,
      data: { video },
      message: 'Video updated successfully'
    });
  } catch (error) {
    console.error('Error updating video:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update video'
    });
  }
});

// DELETE /api/videos/:id - Delete video (Creator/Admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const video = await Video.findById(id);
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    // Check permissions
    const canDelete = video.creatorId.toString() === req.user._id.toString() || 
                     req.user.role === 'Admin';
    
    if (!canDelete) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to delete this video'
      });
    }

    // Delete video and thumbnails from Azure Storage
    const azureStorage = require('../utils/azureStorage');
    
    // Delete main video blob
    if (video.video?.original?.blobName) {
      try {
        await azureStorage.deleteBlob(video.video.original.blobName);
      } catch (error) {
        console.error('Failed to delete video blob:', error);
      }
    }
    
    // Delete thumbnail blobs
    if (video.thumbnails?.poster?.blobName) {
      try {
        await azureStorage.deleteBlob(video.thumbnails.poster.blobName);
      } catch (error) {
        console.error('Failed to delete poster blob:', error);
      }
    }
    
    if (video.thumbnails?.timeline) {
      for (const thumb of video.thumbnails.timeline) {
        if (thumb.blobName) {
          try {
            await azureStorage.deleteBlob(thumb.blobName);
          } catch (error) {
            console.error('Failed to delete timeline thumbnail blob:', error);
          }
        }
      }
    }

    // Delete video document
    await Video.findByIdAndDelete(id);

    // Update user's videos count
    await User.findByIdAndUpdate(video.creatorId, {
      $inc: { 'stats.videosCount': -1 }
    });

    res.json({
      success: true,
      message: 'Video deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete video'
    });
  }
});

// POST /api/videos/:id/like - Like/unlike video
router.post('/:id/like', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const video = await Video.findById(id);
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    const isLiked = video.isLikedBy(req.user._id);
    
    if (isLiked) {
      await video.removeLike(req.user._id);
    } else {
      await video.addLike(req.user._id);
    }

    res.json({
      success: true,
      data: {
        isLiked: !isLiked,
        likesCount: video.stats.likesCount
      },
      message: isLiked ? 'Video unliked' : 'Video liked'
    });
  } catch (error) {
    console.error('Error toggling video like:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle like'
    });
  }
});

// POST /api/videos/:id/view - Update watch time
router.post('/:id/view', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { watchTime } = req.body;

    if (!watchTime || watchTime < 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid watch time is required'
      });
    }

    const video = await Video.findById(id);
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    await video.updateWatchTime(req.user._id, watchTime);

    res.json({
      success: true,
      message: 'Watch time updated'
    });
  } catch (error) {
    console.error('Error updating watch time:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update watch time'
    });
  }
});

module.exports = router;
