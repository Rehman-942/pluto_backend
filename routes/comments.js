const express = require('express');
const Joi = require('joi');
const Comment = require('../models/Comment');
const Video = require('../models/Video');
const { protect, optionalAuth } = require('../middleware/auth');
const { redisClient } = require('../config/redis');

const router = express.Router();

// Validation schemas
const createCommentSchema = Joi.object({
  content: Joi.string().max(500).required(),
  videoId: Joi.string().required(),
  parentId: Joi.string().optional()
});

const updateCommentSchema = Joi.object({
  content: Joi.string().max(500).required()
});

// @route   GET /api/comments/video/:videoId
// @desc    Get comments for a video
// @access  Public
router.get('/video/:videoId', optionalAuth, async (req, res) => {
  try {
    const { videoId } = req.params;
    const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'asc' } = req.query;

    // Try to get from cache first
    const cacheKey = `comments:video:${videoId}:page:${page}:limit:${limit}:_${sortBy}_${sortOrder}`;
    let cachedComments = await redisClient.getComments(cacheKey);
    
    if (cachedComments) {
      return res.json({
        success: true,
        data: cachedComments,
        cached: true
      });
    }

    // Verify video exists
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50),
      sortBy,
      sortOrder: sortOrder === 'desc' ? -1 : 1
    };

    const comments = await Comment.getVideoComments(videoId, options);
    const totalComments = await Comment.countDocuments({ videoId, parentId: null, 'moderation.status': 'approved' });

    // Add user-specific data if authenticated
    if (req.user) {
      comments.forEach(comment => {
        comment.isLiked = comment.likes?.some(like => like.userId.toString() === req.user._id.toString()) || false;
        if (comment.replies) {
          comment.replies.forEach(reply => {
            reply.isLiked = reply.likes?.some(like => like.userId.toString() === req.user._id.toString()) || false;
          });
        }
      });
    }

    const result = {
      comments,
      pagination: {
        page: options.page,
        limit: options.limit,
        total: totalComments,
        pages: Math.ceil(totalComments / options.limit),
        hasMore: options.page < Math.ceil(totalComments / options.limit)
      }
    };

    // Cache for 10 minutes
    await redisClient.setComments(cacheKey, result, 600);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch comments'
    });
  }
});

// @route   GET /api/comments/:id/thread
// @desc    Get comment thread
// @access  Public
router.get('/:id/thread', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;

    // Try to get from cache first
    const cacheKey = `thread_${id}_${limit}`;
    let cachedThread = await redisClient.get('comment_threads', cacheKey);
    
    if (cachedThread) {
      return res.json({
        success: true,
        data: cachedThread,
        cached: true
      });
    }

    const options = {
      limit: Math.min(parseInt(limit), 100)
    };

    const comments = await Comment.getCommentThread(id, options);

    if (comments.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Comment thread not found'
      });
    }

    // Add user-specific data if authenticated
    if (req.user) {
      comments.forEach(comment => {
        comment.isLiked = comment.likes?.some(like => like.userId.toString() === req.user._id.toString()) || false;
      });
    }

    const result = { comments };

    // Cache for 5 minutes
    await redisClient.set('comment_threads', cacheKey, result, 300);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get comment thread error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch comment thread'
    });
  }
});

// @route   POST /api/comments
// @desc    Create a new comment on a video
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    // Validate input
    const { error, value } = createCommentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { videoId, content, parentId } = value;

    // Verify video exists
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Video not found'
      });
    }

    // If replying to a comment, verify parent exists
    if (parentId) {
      const parentComment = await Comment.findById(parentId);
      if (!parentComment || parentComment.videoId.toString() !== videoId) {
        return res.status(400).json({
          success: false,
          error: 'Parent comment not found or belongs to different video'
        });
      }

      // Check nesting level
      if (parentComment.thread.level >= 5) {
        return res.status(400).json({
          success: false,
          error: 'Maximum comment nesting level reached'
        });
      }
    }

    // Create comment
    const comment = new Comment({
      content,
      videoId,
      userId: req.user._id,
      parentId: parentId || null
    });

    await comment.save();
    await comment.populate('userId', 'username firstName lastName avatar');

    // Update video comment count
    await Video.findByIdAndUpdate(videoId, {
      $inc: { 'stats.commentsCount': 1 }
    });

    // Update parent comment reply count if it's a reply
    if (parentId) {
      await Comment.findByIdAndUpdate(parentId, {
        $inc: { 'stats.repliesCount': 1 }
      });
    }

    // Invalidate comment caches
    await Promise.all([
      redisClient.del('comments', `${videoId}_*`),
      redisClient.del('comment_threads', `*${parentId || comment._id}*`),
      redisClient.invalidateVideo(videoId)
    ]);

    res.status(201).json({
      success: true,
      data: { comment },
      message: 'Comment created successfully'
    });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create comment'
    });
  }
});

// @route   PUT /api/comments/:id
// @desc    Update comment
// @access  Private (Owner only)
router.put('/:id', protect, async (req, res) => {
  try {
    // Validate input
    const { error, value } = updateCommentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { content } = value;

    const comment = await Comment.findById(req.params.id);
    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    // Check ownership
    if (comment.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'You can only edit your own comments'
      });
    }

    // Store original content in edit history
    if (!comment.isEdited) {
      comment.editHistory.push({
        content: comment.content,
        editedAt: comment.createdAt
      });
    }

    // Update comment
    comment.content = content;
    comment.isEdited = true;
    comment.editHistory.push({
      content,
      editedAt: new Date()
    });

    await comment.save();
    await comment.populate('userId', 'username firstName lastName avatar');

    // Invalidate caches
    await Promise.all([
      redisClient.del('comments', `${comment.videoId}_*`),
      redisClient.del('comment_threads', `*${req.params.id}*`)
    ]);

    res.json({
      success: true,
      data: { comment },
      message: 'Comment updated successfully'
    });
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update comment'
    });
  }
});

// @route   DELETE /api/comments/:id
// @desc    Delete comment
// @access  Private (Owner only)
router.delete('/:id', protect, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    // Check ownership (or admin)
    if (comment.userId.toString() !== req.user._id.toString() && req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own comments'
      });
    }

    const videoId = comment.videoId;
    const parentId = comment.parentId;

    // Delete comment and all its replies
    const deletedComments = await Comment.deleteMany({
      $or: [
        { _id: comment._id },
        { 'thread.path': new RegExp(`/${comment._id}(/|$)`) }
      ]
    });

    // Update video comment count
    await Video.findByIdAndUpdate(videoId, {
      $inc: { 'stats.commentsCount': -deletedComments.deletedCount }
    });

    // Update parent comment reply count if it was a reply
    if (parentId) {
      const remainingReplies = await Comment.countDocuments({ parentId });
      await Comment.findByIdAndUpdate(parentId, {
        'stats.repliesCount': remainingReplies
      });
    }

    // Invalidate caches
    await Promise.all([
      redisClient.del('comments', `${videoId}_*`),
      redisClient.del('comment_threads', `*${req.params.id}*`),
      redisClient.invalidateVideo(videoId.toString())
    ]);

    res.json({
      success: true,
      message: 'Comment deleted successfully',
      data: { deletedCount: deletedComments.deletedCount }
    });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete comment'
    });
  }
});

// @route   POST /api/comments/:id/like
// @desc    Like/unlike comment
// @access  Private
router.post('/:id/like', protect, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    const isLiked = comment.isLikedBy(req.user._id);
    
    if (isLiked) {
      await comment.removeLike(req.user._id);
    } else {
      await comment.addLike(req.user._id);
    }

    // Invalidate comment caches
    await Promise.all([
      redisClient.del('comments', `${comment.videoId}_*`),
      redisClient.del('comment_threads', `*${req.params.id}*`)
    ]);

    res.json({
      success: true,
      data: {
        isLiked: !isLiked,
        likesCount: comment.stats.likesCount
      },
      message: isLiked ? 'Comment unliked' : 'Comment liked'
    });
  } catch (error) {
    console.error('Like comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to like/unlike comment'
    });
  }
});

// @route   POST /api/comments/:id/report
// @desc    Report comment
// @access  Private
router.post('/:id/report', protect, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || !['spam', 'inappropriate', 'harassment', 'hate_speech', 'other'].includes(reason)) {
      return res.status(400).json({
        success: false,
        error: 'Valid reason is required'
      });
    }

    const comment = await Comment.findById(req.params.id);
    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    // Add flag if not already present
    if (!comment.moderation.flags.includes(reason)) {
      comment.moderation.flags.push(reason);
      comment.moderation.flags = [...new Set(comment.moderation.flags)]; // Remove duplicates
      
      // Increment report count
      comment.stats.reportsCount += 1;

      // Auto-moderate if too many reports
      if (comment.stats.reportsCount >= 5) {
        comment.moderation.status = 'pending';
      }

      await comment.save();

      // Invalidate caches
      await Promise.all([
        redisClient.del('comments', `${comment.videoId}_*`),
        redisClient.del('comment_threads', `*${req.params.id}*`)
      ]);
    }

    res.json({
      success: true,
      message: 'Comment reported successfully'
    });
  } catch (error) {
    console.error('Report comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to report comment'
    });
  }
});

// @route   GET /api/comments/user/:userId
// @desc    Get user's comments
// @access  Public
router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50)
    };

    const comments = await Comment.find({
      userId,
      'moderation.status': 'approved'
    })
    .populate('userId', 'username firstName lastName avatar')
    .populate('videoId', 'title images.thumbnail creatorId')
    .sort({ createdAt: -1 })
    .limit(options.limit)
    .skip((options.page - 1) * options.limit)
    .lean();

    const total = await Comment.countDocuments({
      userId,
      'moderation.status': 'approved'
    });

    // Add user-specific data if authenticated
    if (req.user) {
      comments.forEach(comment => {
        comment.isLiked = comment.likes?.some(like => like.userId.toString() === req.user._id.toString()) || false;
      });
    }

    const result = {
      comments,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.ceil(total / options.limit),
        hasMore: options.page < Math.ceil(total / options.limit)
      }
    };

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get user comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user comments'
    });
  }
});

module.exports = router;
