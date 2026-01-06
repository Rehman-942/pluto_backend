const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const azureStorage = require('./azureStorage');
const fs = require('fs');
const path = require('path');

// Set the path to the static FFmpeg binary
ffmpeg.setFfmpegPath(ffmpegStatic);

class VideoProcessor {
  constructor() {
    this.tempDir = path.join(__dirname, '../temp');
    this.ensureTempDir();
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Generate video thumbnails at different timestamps
   * @param {string} videoPath - Path to the video file
   * @param {number} duration - Video duration in seconds
   * @returns {Promise<Array>} Array of thumbnail paths
   */
  async generateThumbnails(videoPath, duration) {
    const thumbnails = [];
    const timestamps = this.calculateThumbnailTimestamps(duration);
    
    for (const timestamp of timestamps) {
      try {
        const thumbnailPath = await this.generateThumbnailAtTimestamp(videoPath, timestamp);
        thumbnails.push({
          path: thumbnailPath,
          timestamp
        });
      } catch (error) {
        console.error(`Error generating thumbnail at ${timestamp}s:`, error);
      }
    }

    return thumbnails;
  }

  /**
   * Calculate optimal timestamps for thumbnails
   * @param {number} duration - Video duration in seconds
   * @returns {Array<number>} Array of timestamps
   */
  calculateThumbnailTimestamps(duration) {
    const timestamps = [];
    
    // Always add poster (10% into video or 5 seconds, whichever is smaller)
    const posterTime = Math.min(duration * 0.1, 5);
    timestamps.push(posterTime);

    // Add timeline thumbnails
    if (duration > 30) {
      // For videos longer than 30 seconds, add 5-8 thumbnails
      const count = Math.min(8, Math.max(5, Math.floor(duration / 30)));
      for (let i = 1; i < count; i++) {
        timestamps.push((duration / count) * i);
      }
    } else if (duration > 10) {
      // For shorter videos, add 3 thumbnails
      timestamps.push(duration * 0.33, duration * 0.66);
    }

    return timestamps;
  }

  /**
   * Generate thumbnail at specific timestamp
   * @param {string} videoPath - Path to the video file
   * @param {number} timestamp - Timestamp in seconds
   * @returns {Promise<string>} Path to generated thumbnail
   */
  generateThumbnailAtTimestamp(videoPath, timestamp) {
    return new Promise((resolve, reject) => {
      const outputFileName = `thumb_${Date.now()}_${Math.floor(timestamp)}.jpg`;
      const outputPath = path.join(this.tempDir, outputFileName);

      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .size('1280x720')
        .format('jpg')
        .output(outputPath)
        .on('end', () => {
          resolve(outputPath);
        })
        .on('error', (error) => {
          reject(error);
        })
        .run();
    });
  }

  /**
   * Get video metadata using ffprobe
   * @param {string} videoPath - Path to the video file
   * @returns {Promise<Object>} Video metadata
   */
  getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (error, metadata) => {
        if (error) {
          reject(error);
        } else {
          const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
          const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
          
          resolve({
            duration: parseFloat(metadata.format.duration),
            size: parseInt(metadata.format.size),
            bitRate: parseInt(metadata.format.bit_rate),
            format: metadata.format.format_name,
            video: videoStream ? {
              codec: videoStream.codec_name,
              width: videoStream.width,
              height: videoStream.height,
              frameRate: this.parseFrameRate(videoStream.r_frame_rate),
              bitRate: parseInt(videoStream.bit_rate)
            } : null,
            audio: audioStream ? {
              codec: audioStream.codec_name,
              bitRate: parseInt(audioStream.bit_rate),
              sampleRate: parseInt(audioStream.sample_rate),
              channels: audioStream.channels
            } : null
          });
        }
      });
    });
  }

  /**
   * Parse frame rate from ffprobe format
   * @param {string} frameRate - Frame rate string (e.g., "30/1")
   * @returns {number} Frame rate as number
   */
  parseFrameRate(frameRate) {
    if (!frameRate) return 0;
    const [num, den] = frameRate.split('/').map(Number);
    return num / (den || 1);
  }

  /**
   * Upload thumbnails to Azure Storage
   * @param {Array} thumbnails - Array of thumbnail objects with path and timestamp
   * @param {string} videoPublicId - Public ID of the video
   * @returns {Promise<Object>} Azure Storage upload results
   */
  async uploadThumbnailsToAzure(thumbnails, videoPublicId) {
    const uploadPromises = thumbnails.map(async (thumbnail, index) => {
      try {
        const uploadResult = await azureStorage.uploadThumbnail(
          thumbnail.path,
          videoPublicId,
          index,
          thumbnail.timestamp
        );

        // Clean up local file
        this.cleanupFile(thumbnail.path);

        return {
          url: uploadResult.url,
          blobName: uploadResult.blobName,
          width: 1280, // Standard thumbnail width
          height: 720, // Standard thumbnail height
          timestamp: thumbnail.timestamp
        };
      } catch (error) {
        console.error(`Error uploading thumbnail:`, error);
        this.cleanupFile(thumbnail.path);
        return null;
      }
    });

    const results = await Promise.all(uploadPromises);
    return results.filter(result => result !== null);
  }

  /**
   * Generate poster thumbnail (main thumbnail for video)
   * @param {string} videoPath - Path to the video file
   * @param {number} timestamp - Timestamp for poster (usually 10% into video)
   * @returns {Promise<string>} Path to poster thumbnail
   */
  async generatePoster(videoPath, timestamp = 5) {
    const outputFileName = `poster_${Date.now()}.jpg`;
    const outputPath = path.join(this.tempDir, outputFileName);

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .size('1920x1080')
        .format('jpg')
        .outputOptions(['-q:v 2']) // High quality
        .output(outputPath)
        .on('end', () => {
          resolve(outputPath);
        })
        .on('error', (error) => {
          reject(error);
        })
        .run();
    });
  }

  /**
   * Generate video upload for Azure Storage
   * @param {string} videoPath - Path to the video file
   * @param {string} videoPublicId - Public ID for the video
   * @returns {Promise<Object>} Video upload info
   */
  async uploadVideoToAzure(videoPath, videoPublicId, metadata) {
    try {
      // Upload original video to Azure Storage
      const originalUpload = await azureStorage.uploadVideo(videoPath, videoPublicId);

      const variants = {
        original: {
          url: originalUpload.url,
          blobName: originalUpload.blobName,
          width: metadata.video?.width || 1920,
          height: metadata.video?.height || 1080,
          duration: metadata.duration,
          format: 'mp4',
          bytes: metadata.size
        },
        // For now, we'll use the same video for all qualities
        // In production, you might want to implement FFmpeg transcoding
        qualities: {
          hd: {
            url: originalUpload.url,
            blobName: originalUpload.blobName,
            width: metadata.video?.width || 1920,
            height: metadata.video?.height || 1080
          },
          sd: {
            url: originalUpload.url,
            blobName: originalUpload.blobName,
            width: Math.floor((metadata.video?.width || 1920) * 0.75),
            height: Math.floor((metadata.video?.height || 1080) * 0.75)
          },
          mobile: {
            url: originalUpload.url,
            blobName: originalUpload.blobName,
            width: Math.floor((metadata.video?.width || 1920) * 0.5),
            height: Math.floor((metadata.video?.height || 1080) * 0.5)
          }
        }
      };

      return variants;
    } catch (error) {
      console.error('Error uploading video to Azure:', error);
      throw error;
    }
  }

  /**
   * Process complete video upload with thumbnails
   * @param {string} videoPath - Path to the video file
   * @param {string} videoPublicId - Public ID for the video
   * @returns {Promise<Object>} Complete processing result
   */
  async processVideo(videoPath, videoPublicId) {
    try {
      console.log(`Starting video processing for ${videoPublicId}`);
      
      // Get video metadata
      const metadata = await this.getVideoMetadata(videoPath);
      console.log(`Video metadata obtained: ${metadata.duration}s duration`);

      // Generate thumbnails
      const thumbnails = await this.generateThumbnails(videoPath, metadata.duration);
      console.log(`Generated ${thumbnails.length} thumbnails`);

      // Upload video to Azure Storage
      const videoVariants = await this.uploadVideoToAzure(videoPath, videoPublicId, metadata);
      console.log(`Video uploaded to Azure Storage`);

      // Upload thumbnails to Azure Storage
      const azureThumbnails = await this.uploadThumbnailsToAzure(thumbnails, videoPublicId);
      console.log(`Thumbnails uploaded to Azure Storage`);

      // Organize thumbnails by type
      const organizedThumbnails = this.organizeThumbnails(azureThumbnails);

      // Clean up local video file
      this.cleanupFile(videoPath);

      return {
        video: videoVariants,
        thumbnails: organizedThumbnails,
        metadata: {
          ...metadata,
          processingStatus: 'completed',
          processedAt: new Date()
        }
      };
    } catch (error) {
      console.error('Error processing video:', error);
      // Clean up on error
      this.cleanupFile(videoPath);
      throw error;
    }
  }

  /**
   * Organize thumbnails by type (poster, timeline, sizes)
   * @param {Array} thumbnails - Array of thumbnail objects
   * @returns {Object} Organized thumbnail object
   */
  organizeThumbnails(thumbnails) {
    if (!thumbnails.length) return {};

    // First thumbnail is poster
    const poster = thumbnails[0];
    
    // Rest are timeline thumbnails
    const timeline = thumbnails.slice(1);

    return {
      poster: {
        url: poster.url,
        blobName: poster.blobName,
        width: poster.width,
        height: poster.height
      },
      timeline: timeline.map(thumb => ({
        url: thumb.url,
        blobName: thumb.blobName,
        timestamp: thumb.timestamp,
        width: thumb.width,
        height: thumb.height
      })),
      large: poster, // Use poster as large thumbnail
      medium: poster, // For now, use same - could generate different sizes
      small: poster   // For now, use same - could generate different sizes
    };
  }

  /**
   * Clean up temporary files
   * @param {string} filePath - Path to file to clean up
   */
  cleanupFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error(`Error cleaning up file ${filePath}:`, error);
    }
  }

  /**
   * Clean up old temporary files
   */
  cleanupOldFiles() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const oneHourAgo = Date.now() - (60 * 60 * 1000);

      files.forEach(file => {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtimeMs < oneHourAgo) {
          fs.unlinkSync(filePath);
        }
      });
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

module.exports = new VideoProcessor();
