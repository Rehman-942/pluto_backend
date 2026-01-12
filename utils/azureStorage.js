const { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } = require('@azure/storage-blob');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class AzureStorageService {
  constructor() {
    this.connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    this.containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'videos';
    
    if (!this.connectionString) {
      throw new Error('Azure Storage connection string is required');
    }

    // Extract account name and key from connection string for SAS token generation
    const accountNameMatch = this.connectionString.match(/AccountName=([^;]+)/);
    const accountKeyMatch = this.connectionString.match(/AccountKey=([^;]+)/);
    
    this.accountName = accountNameMatch ? accountNameMatch[1] : null;
    this.accountKey = accountKeyMatch ? accountKeyMatch[1] : null;

    if (!this.accountName || !this.accountKey) {
      throw new Error('Could not extract account name and key from connection string');
    }

    // Create credential for SAS token generation
    this.credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);

    this.blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
    this.containerClient = this.blobServiceClient.getContainerClient(this.containerName);
    this.ensureContainer();
  }

  async ensureContainer() {
    try {
      await this.containerClient.createIfNotExists({
        access: 'blob'
      });
    } catch (error) {
      console.error('Error creating container:', error);
    }
  }

  /**
   * Upload buffer to Azure Blob Storage
   * @param {Buffer} buffer - File buffer
   * @param {string} folder - Folder path (e.g., 'avatars', 'videos', 'video_thumbnails')
   * @param {string} filename - File name
   * @param {string} contentType - MIME type
   * @returns {Promise<Object>} Upload result
   */
  async uploadBuffer(buffer, folder, filename, contentType) {
    try {
      const blobName = `${folder}/${filename}`;
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });

      return {
        url: blockBlobClient.url,
        blobName: blobName,
        container: this.containerName,
        accountName: this.accountName
      };
    } catch (error) {
      console.error('Error uploading to Azure:', error);
      throw error;
    }
  }

  /**
   * Upload file to Azure Blob Storage
   * @param {string} filePath - Local file path
   * @param {string} folder - Folder path
   * @param {string} filename - File name
   * @param {string} contentType - MIME type
   * @returns {Promise<Object>} Upload result
   */
  async uploadFile(filePath, folder, filename, contentType) {
    try {
      const blobName = `${folder}/${filename}`;
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadFile(filePath, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });

      return {
        url: blockBlobClient.url,
        blobName: blobName,
        container: this.containerName,
        accountName: this.accountName
      };
    } catch (error) {
      console.error('Error uploading file to Azure:', error);
      throw error;
    }
  }

  /**
   * Upload avatar image
   * @param {Buffer} buffer - Image buffer
   * @param {string} userId - User ID for unique naming
   * @returns {Promise<Object>} Upload result
   */
  async uploadAvatar(buffer) {
    const filename = `avatar_${uuidv4()}.jpg`;
    return this.uploadBuffer(buffer, 'pluto/avatars', filename, 'image/jpeg');
  }

  /**
   * Upload video file
   * @param {string} filePath - Local video file path
   * @param {string} videoPublicId - Public ID for the video
   * @returns {Promise<Object>} Upload result
   */
  async uploadVideo(filePath, videoPublicId) {
    const filename = `${videoPublicId}.mp4`;
    return this.uploadFile(filePath, 'videos', filename, 'video/mp4');
  }

  /**
   * Upload thumbnail image
   * @param {string} filePath - Local thumbnail path
   * @param {string} videoPublicId - Video public ID
   * @param {number} index - Thumbnail index
   * @param {number} timestamp - Thumbnail timestamp
   * @returns {Promise<Object>} Upload result
   */
  async uploadThumbnail(filePath, videoPublicId, index, timestamp) {
    const filename = `${videoPublicId}_thumb_${index}_${Math.floor(timestamp)}.jpg`;
    return this.uploadFile(filePath, 'video_thumbnails', filename, 'image/jpeg');
  }

  /**
   * Delete blob from Azure Storage
   * @param {string} blobName - Blob name to delete
   * @returns {Promise<void>}
   */
  async deleteBlob(blobName) {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.deleteIfExists();
    } catch (error) {
      console.error('Error deleting blob:', error);
      throw error;
    }
  }

  /**
   * Generate a blob URL
   * @param {string} blobName - Blob name
   * @returns {string} Blob URL
   */
  getBlobUrl(blobName) {
    return `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${blobName}`;
  }

  /**
   * Extract blob name from URL
   * @param {string} url - Azure blob URL
   * @returns {string} Blob name
   */
  extractBlobNameFromUrl(url) {
    const urlParts = url.split('/');
    const containerIndex = urlParts.findIndex(part => part === this.containerName);
    if (containerIndex === -1) return null;
    
    return urlParts.slice(containerIndex + 1).join('/');
  }

  /**
   * Generate SAS token for direct video upload
   * @param {string} videoPublicId - Unique video identifier
   * @param {string} userId - User ID for folder structure
   * @returns {Object} Upload URL and blob details
   */
  generateVideoUploadSAS(videoPublicId, userId) {
    const blobName = `videos/${videoPublicId}.mp4`;
    const expiresOn = new Date();
    expiresOn.setHours(expiresOn.getHours() + 1); // 1 hour expiry

    const permissions = BlobSASPermissions.parse('cw'); // create, write
    
    const sasToken = generateBlobSASQueryParameters({
      containerName: this.containerName,
      blobName,
      permissions,
      expiresOn,
    }, this.credential).toString();

    const uploadUrl = `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${blobName}?${sasToken}`;

    return {
      uploadUrl,
      blobName,
      blobUrl: `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${blobName}`,
      expiresOn: expiresOn.toISOString(),
      videoPublicId
    };
  }

  /**
   * Generate SAS token for thumbnail upload
   * @param {string} videoPublicId - Video public ID
   * @param {number} index - Thumbnail index
   * @returns {Object} Upload URL and blob details
   */
  generateThumbnailUploadSAS(videoPublicId, index) {
    const blobName = `video_thumbnails/${videoPublicId}_thumb_${index}.jpg`;
    const expiresOn = new Date();
    expiresOn.setHours(expiresOn.getHours() + 1); // 1 hour expiry

    const permissions = BlobSASPermissions.parse('cw'); // create, write
    
    const sasToken = generateBlobSASQueryParameters({
      containerName: this.containerName,
      blobName,
      permissions,
      expiresOn,
    }, this.credential).toString();

    const uploadUrl = `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${blobName}?${sasToken}`;

    return {
      uploadUrl,
      blobName,
      blobUrl: `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${blobName}`,
      expiresOn: expiresOn.toISOString()
    };
  }
}

module.exports = new AzureStorageService();
