const express = require('express');
const Joi = require('joi');
const { authenticateToken, requireRole } = require('../middleware/auth');
const azureStorage = require('../utils/azureStorage');
const Video = require('../models/Video');
const User = require('../models/User');

const router = express.Router();

// Generate SAS token for video upload
router.post('/video-sas', 
  async (req, res) => {
    try {
      const userId = 'anonymous_' + Date.now();
      const videoPublicId = `video_${Date.now()}_${userId}`;
      
      const sasData = azureStorage.generateVideoUploadSAS(videoPublicId, userId);
      
      console.log('Generated SAS token for video upload:', {
        videoPublicId,
        userId,
        expiresOn: sasData.expiresOn
      });

      res.json({
        success: true,
        data: sasData
      });
    } catch (error) {
      console.error('Error generating video SAS token:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate upload token'
      });
    }
  }
);

// Complete video upload (after direct Azure upload)
const videoCompleteSchema = Joi.object({
  videoPublicId: Joi.string().required(),
  blobUrl: Joi.string().uri().required(),
  title: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(1000).optional().allow(''),
  visibility: Joi.string().valid('public', 'unlisted', 'private').default('public'),
  tags: Joi.array().items(Joi.string().max(50)).max(10).optional().default([]),
  metadata: Joi.object({
    fileName: Joi.string().required(),
    mimeType: Joi.string().required(),
    fileSize: Joi.number().required(),
    duration: Joi.number().optional()
  }).required()
});

router.post('/video-complete',
  async (req, res) => {
    try {
      const { error, value } = videoCompleteSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: error.details[0].message
        });
      }

      const { videoPublicId, blobUrl, title, description, visibility, tags, metadata } = value;

      console.log('Completing video upload:', {
        videoPublicId,
        title,
        visibility
      });

      // Create anonymous user ID from videoPublicId
      const anonymousUserId = null;

      // Create video document
      const videoData = {
        title,
        description: description || '',
        creatorId: anonymousUserId,
        tags: tags || [],
        visibility,
        video: {
          url: blobUrl,
          publicId: videoPublicId,
          format: 'mp4'
        },
        thumbnails: [], // Will be populated when thumbnails are generated
        metadata: {
          fileName: metadata.fileName,
          mimeType: metadata.mimeType,
          fileSize: metadata.fileSize,
          duration: metadata.duration || null,
          uploadedAt: new Date()
        },
        status: 'processing' // Will be updated when thumbnails are ready
      };

      const video = new Video(videoData);
      await video.save();

      // Skip user stats update for anonymous uploads

      console.log('Video upload completed successfully:', video._id);

      res.status(201).json({
        success: true,
        data: {
          video: video.toObject()
        },
        message: 'Video uploaded successfully'
      });

    } catch (error) {
      console.error('Error completing video upload:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to complete video upload'
      });
    }
  }
);

// Generate thumbnail upload SAS tokens
router.post('/thumbnail-sas/:videoId',
  async (req, res) => {
    try {
      const { videoId } = req.params;
      const { count = 3 } = req.body; // Default 3 thumbnails

      // Find video (no ownership check for anonymous uploads)
      const video = await Video.findById(videoId);
      if (!video) {
        return res.status(404).json({
          success: false,
          error: 'Video not found'
        });
      }

      // Generate SAS tokens for thumbnails
      const thumbnailTokens = [];
      for (let i = 0; i < Math.min(count, 5); i++) {
        const sasData = azureStorage.generateThumbnailUploadSAS(video.video.publicId, i);
        thumbnailTokens.push({
          index: i,
          ...sasData
        });
      }

      res.json({
        success: true,
        data: {
          videoId,
          thumbnails: thumbnailTokens
        }
      });

    } catch (error) {
      console.error('Error generating thumbnail SAS tokens:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate thumbnail tokens'
      });
    }
  }
);

// Update video with thumbnails
router.patch('/video-thumbnails/:videoId',
  async (req, res) => {
    try {
      const { videoId } = req.params;
      const { thumbnails } = req.body;

      // Find video (no ownership check for anonymous uploads)
      const video = await Video.findById(videoId);
      if (!video) {
        return res.status(404).json({
          success: false,
          error: 'Video not found'
        });
      }

      // Update video with thumbnails and mark as ready
      await Video.findByIdAndUpdate(videoId, {
        thumbnails: thumbnails,
        status: 'ready',
        'metadata.processedAt': new Date()
      });

      res.json({
        success: true,
        message: 'Video thumbnails updated successfully'
      });

    } catch (error) {
      console.error('Error updating video thumbnails:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update thumbnails'
      });
    }
  }
);

module.exports = router;
