require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
// const { createTerminus } = require('@godaddy/terminus');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sanitize = require('sanitize-filename');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 4000;

// AWS S3 configuration using environment variables
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Health check function
// async function healthCheck() {
//     try {
//         // Basic server check
//         if (!server.listening) {
//             throw new Error('Server is not listening');
//         }

//         // Check S3 connection
//         try {
//             await s3Client.send(new ListObjectsV2Command({
//                 Bucket: process.env.S3_BUCKET,
//                 MaxKeys: 1
//             }));
//         } catch (error) {
//             console.error('S3 health check failed:', error);
//             // Don't fail health check for S3 issues in development
//             if (process.env.NODE_ENV === 'production') {
//                 throw new Error('S3 connection failed');
//             }
//         }

//         // Check FFmpeg installation
//         try {
//             await new Promise((resolve, reject) => {
//                 ffmpeg.ffprobe('-version', (err) => {
//                     if (err) {
//                         reject(new Error('FFmpeg not installed'));
//                     }
//                     resolve();
//                 });
//             });
//         } catch (error) {
//             console.error('FFmpeg health check failed:', error);
//             throw error;
//         }

//         return { status: 'healthy' };
//     } catch (error) {
//         console.error('Health check failed:', error);
//         throw error;
//     }
// }

// // Terminus configuration
// const terminusOptions = {
//     healthChecks: {
//         '/healthcheck': { status: 'healthy' },
//         verbatim: true
//     },
//     timeout: 5000, // Increased timeout
//     signals: ['SIGTERM', 'SIGINT'],
//     beforeShutdown: async () => {
//         // Perform cleanup
//         console.log('Cleaning up before shutdown...');
//         await new Promise(resolve => setTimeout(resolve, 1000));
//     },
//     onSignal: async () => {
//         console.log('Server is starting cleanup');
//         // Add any cleanup logic here
//     },
//     onShutdown: async () => {
//         console.log('Cleanup finished, server is shutting down');
//     }
// };

// // Initialize terminus
// createTerminus(server, terminusOptions);

// Multer configuration for file upload
const storage = multer.diskStorage({
    destination: './uploads',
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Create uploads directory if not exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}
if (!fs.existsSync('./hls')) {
    fs.mkdirSync('./hls');
}

// Serve static files
app.use(express.static('public'));

// Sanitize video name
function getSanitizedVideoName(filename) {
    return sanitize(path.parse(filename).name).replace(/[^a-zA-Z0-9-_]/g, '_');
}

// Kiểm tra stream
async function getStreamInfo(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.streams);
        });
    });
}

// Convert video to HLS with multiple qualities
async function convertToHLS(inputPath, outputDir, videoName) {
    return new Promise(async (resolve, reject) => {
        try {
            const sanitizedVideoName = getSanitizedVideoName(videoName);
            
            // Quality variants
            const qualities = [
                { name: '720p', bitrate: '2500k', resolution: '1280x720' },
                { name: '480p', bitrate: '1500k', resolution: '854x480' },
                { name: '360p', bitrate: '800k', resolution: '640x360' }
            ];

            // Create master playlist
            const masterPlaylist = '#EXTM3U\n#EXT-X-VERSION:3\n';
            const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
            fs.writeFileSync(masterPlaylistPath, masterPlaylist);

            // Convert each quality variant
            const conversionPromises = qualities.map((quality) => {
                return new Promise((resolveQuality, rejectQuality) => {
                    const variantDir = path.join(outputDir, quality.name);
                    if (!fs.existsSync(variantDir)) {
                        fs.mkdirSync(variantDir);
                    }

                    const outputOptions = [
                        '-c:v libx264',              // Video codec
                        '-c:a aac',                  // Audio codec
                        '-b:v ' + quality.bitrate,   // Video bitrate
                        '-vf scale=' + quality.resolution.replace('x', ':'), // Resolution
                        '-hls_time 10',              // Segment duration
                        '-hls_list_size 0',          // Keep all segments
                        '-hls_segment_type mpegts',  // Segment type
                        '-hls_playlist_type vod'     // VOD playlist
                    ];

                    ffmpeg(inputPath)
                        .outputOptions(outputOptions)
                        .output(path.join(variantDir, 'playlist.m3u8'))
                        .on('end', () => {
                            // Append to master playlist
                            const bandwidthKbps = parseInt(quality.bitrate.replace('k', '')) * 1000;
                            const variantEntry = `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthKbps},RESOLUTION=${quality.resolution}\n${quality.name}/playlist.m3u8\n`;
                            fs.appendFileSync(masterPlaylistPath, variantEntry);
                            resolveQuality();
                        })
                        .on('error', (err) => {
                            console.error(`Error converting ${quality.name}:`, err);
                            rejectQuality(err);
                        })
                        .run();
                });
            });

            // Wait for all qualities to be converted
            await Promise.all(conversionPromises);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

// Upload file to S3
async function uploadToS3(filePath, bucketName, objectName) {
    const fileContent = fs.readFileSync(filePath);
    const params = {
        Bucket: bucketName,
        Key: objectName,
        Body: fileContent
    };
    await s3Client.send(new PutObjectCommand(params));
}

// Add this new helper function
async function uploadDirectoryToS3(localDir, bucketName, s3Prefix) {
    const items = fs.readdirSync(localDir);
    
    for (const item of items) {
        const localPath = path.join(localDir, item);
        const s3Key = path.join(s3Prefix, item).replace(/\\/g, '/');
        
        if (fs.statSync(localPath).isDirectory()) {
            // Recursively upload subdirectories
            await uploadDirectoryToS3(localPath, bucketName, s3Key);
        } else {
            // Upload file
            const fileContent = fs.readFileSync(localPath);
            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: s3Key,
                Body: fileContent
            }));
        }
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/videos', async (req, res) => {
    try {
        const bucketName = process.env.S3_BUCKET;
        const params = {
            Bucket: bucketName
        };
        const data = await s3Client.send(new ListObjectsV2Command(params));
        const videos = data.Contents
            .filter(obj => obj.Key.endsWith('/master.m3u8'))
            .map(obj => `https://${bucketName}.s3.ap-southeast-1.amazonaws.com/${obj.Key}`);
        res.json(videos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all HLS playlists from S3
app.get('/api/playlists', async (req, res) => {
    try {
        const bucketName = process.env.S3_BUCKET;
        const params = {
            Bucket: bucketName
        };

        const data = await s3Client.send(new ListObjectsV2Command(params));
        
        // Filter and organize playlists
        const playlists = data.Contents
            .filter(obj => obj.Key.endsWith('.m3u8'))
            .map(obj => {
                const key = obj.Key;
                const isVariant = key.includes('/playlist.m3u8');
                const isMaster = key.endsWith('/master.m3u8');
                
                return {
                    key: key,
                    url: `https://${bucketName}.s3.ap-southeast-1.amazonaws.com/${key}`,
                    type: isVariant ? 'variant' : (isMaster ? 'master' : 'unknown'),
                    lastModified: obj.LastModified,
                    size: obj.Size,
                    folder: key.split('/')[0]
                };
            })
            // Group by video folder
            .reduce((acc, playlist) => {
                if (!acc[playlist.folder]) {
                    acc[playlist.folder] = {
                        master: null,
                        variants: []
                    };
                }
                
                if (playlist.type === 'master') {
                    acc[playlist.folder].master = playlist;
                } else if (playlist.type === 'variant') {
                    acc[playlist.folder].variants.push(playlist);
                }
                
                return acc;
            }, {});

        res.json({
            success: true,
            data: playlists
        });
    } catch (err) {
        console.error('Error fetching playlists:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Update the upload route
app.post('/upload', upload.single('video'), async (req, res) => {
    try {
        const file = req.file;
        const bucketName = process.env.S3_BUCKET;
        const videoName = path.parse(file.filename).name;
        const sanitizedVideoName = getSanitizedVideoName(videoName);
        const outputDir = path.join('./hls', sanitizedVideoName);

        // Create temporary HLS directory
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }

        // Upload original video file to S3
        const originalVideoKey = `${sanitizedVideoName}/original/${file.filename}`;
        await uploadToS3(file.path, bucketName, originalVideoKey);

        // Convert to HLS
        await convertToHLS(file.path, outputDir, videoName);

        // Upload HLS files to S3 under the same prefix as original video
        await uploadDirectoryToS3(outputDir, bucketName, sanitizedVideoName);

        // Clean up local files
        fs.unlinkSync(file.path);
        fs.rmSync(outputDir, { recursive: true });

        // Return success response with file locations
        res.json({
            success: true,
            message: 'Video uploaded and converted successfully',
            data: {
                originalVideo: `https://${bucketName}.s3.ap-southeast-1.amazonaws.com/${originalVideoKey}`,
                masterPlaylist: `https://${bucketName}.s3.ap-southeast-1.amazonaws.com/${sanitizedVideoName}/master.m3u8`
            }
        });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Start server using http.server instead of express
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});