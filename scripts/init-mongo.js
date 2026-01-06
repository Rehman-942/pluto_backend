// MongoDB initialization script for Docker
print('Starting MongoDB initialization...');

// Switch to the pluto database
db = db.getSiblingDB('pluto');

// Create application user
db.createUser({
  user: 'plutoapp',
  pwd: 'apppassword123',
  roles: [
    {
      role: 'readWrite',
      db: 'pluto'
    }
  ]
});

// Create collections with validation
db.createCollection('users', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['username', 'email', 'password', 'firstName', 'lastName', 'role'],
      properties: {
        username: {
          bsonType: 'string',
          pattern: '^[a-zA-Z0-9_]{3,30}$',
          description: 'Username must be 3-30 characters, alphanumeric and underscores only'
        },
        email: {
          bsonType: 'string',
          pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
          description: 'Must be a valid email address'
        },
        role: {
          enum: ['Admin', 'Creator', 'Consumer'],
          description: 'Must be one of Admin, Creator, or Consumer'
        }
      }
    }
  }
});

db.createCollection('videos', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['title', 'creatorId', 'video'],
      properties: {
        title: {
          bsonType: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Title must be 1-200 characters'
        },
        visibility: {
          enum: ['public', 'unlisted', 'private'],
          description: 'Must be public, unlisted, or private'
        }
      }
    }
  }
});

db.createCollection('comments', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['content', 'userId', 'videoId'],
      properties: {
        content: {
          bsonType: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Comment content must be 1-500 characters'
        },
        videoId: {
          bsonType: 'objectId'
        }
      }
    }
  }
});

// Create indexes for performance
print('Creating indexes...');

// User indexes
db.users.createIndex({ username: 1 }, { unique: true });
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ role: 1 });
db.users.createIndex({ createdAt: -1 });

// Video indexes
db.videos.createIndex({ creatorId: 1 });
db.videos.createIndex({ createdAt: -1 });
db.videos.createIndex({ visibility: 1 });
db.videos.createIndex({ tags: 1 });
db.videos.createIndex({ 'stats.likesCount': -1 });
db.videos.createIndex({ 'stats.viewsCount': -1 });
db.videos.createIndex({ 'video.original.duration': 1 });
db.videos.createIndex({ 'metadata.processingStatus': 1 });
db.videos.createIndex({ title: 'text', description: 'text', tags: 'text' });

// Comment indexes
db.comments.createIndex({ videoId: 1 });
db.comments.createIndex({ userId: 1 });
db.comments.createIndex({ parentId: 1 });
db.comments.createIndex({ createdAt: -1 });

// Create demo admin user
print('Creating demo admin user...');
db.users.insertOne({
  username: 'admin',
  email: 'admin@pluto.com',
  password: '$2b$10$rQZ9j0m5K6vRxGxYvF5F2.ZhGy8W1p6L9D4E8S7Q3X2C5V6N1M0B8', // password123
  firstName: 'Admin',
  lastName: 'User',
  role: 'Admin',
  isActive: true,
  preferences: {
    publicProfile: true,
    emailNotifications: true,
    pushNotifications: false
  },
  stats: {
    videosCount: 0,
    followersCount: 0,
    totalViews: 0,
    totalLikes: 0
  },
  createdAt: new Date(),
  updatedAt: new Date()
});

// Create demo creator user
print('Creating demo creator user...');
db.users.insertOne({
  username: 'demo_creator',
  email: 'demo.creator@pluto.com',
  password: '$2b$10$rQZ9j0m5K6vRxGxYvF5F2.ZhGy8W1p6L9D4E8S7Q3X2C5V6N1M0B8', // password123
  firstName: 'Demo',
  lastName: 'Creator',
  role: 'Creator',
  bio: 'Professional videographer and content creator. Sharing my visual stories.',
  isActive: true,
  preferences: {
    publicProfile: true,
    emailNotifications: true,
    pushNotifications: true
  },
  stats: {
    videosCount: 0,
    followersCount: 0,
    totalViews: 0,
    totalLikes: 0
  },
  createdAt: new Date(),
  updatedAt: new Date()
});

// Create demo consumer user
print('Creating demo consumer user...');
db.users.insertOne({
  username: 'demo_consumer',
  email: 'demo.consumer@pluto.com',
  password: '$2b$10$rQZ9j0m5K6vRxGxYvF5F2.ZhGy8W1p6L9D4E8S7Q3X2C5V6N1M0B8', // password123
  firstName: 'Demo',
  lastName: 'Consumer',
  role: 'Consumer',
  bio: 'Video enthusiast and content lover.',
  isActive: true,
  preferences: {
    publicProfile: true,
    emailNotifications: false,
    pushNotifications: false
  },
  stats: {
    videosCount: 0,
    followersCount: 0,
    totalViews: 0,
    totalLikes: 0
  },
  createdAt: new Date(),
  updatedAt: new Date()
});

print('MongoDB initialization completed successfully!');
print('Demo users created:');
print('- Admin: admin@pluto.com / password123');
print('- Creator: demo.creator@pluto.com / password123');
print('- Consumer: demo.consumer@pluto.com / password123');
