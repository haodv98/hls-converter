const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

class StorageService {
    constructor() {
        this.mode = process.env.STORAGE_MODE || 'local';
        this.s3Client = null;
        
        if (this.mode === 's3') {
            this.s3Client = new S3Client({
                region: process.env.AWS_REGION,
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }
            });
        }
    }

    async uploadFile(localPath, destinationPath) {
        if (this.mode === 's3') {
            const fileContent = fs.readFileSync(localPath);
            await this.s3Client.send(new PutObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: destinationPath,
                Body: fileContent
            }));
            return `https://${process.env.S3_BUCKET}.s3.ap-southeast-1.amazonaws.com/${destinationPath}`;
        } else {
            const destPath = path.join(process.cwd(), 'uploads', destinationPath);
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
            fs.copyFileSync(localPath, destPath);
            return `/uploads/${destinationPath}`;
        }
    }

    async uploadDirectory(localDir, destinationPrefix) {
        const items = fs.readdirSync(localDir);
        const urls = [];

        for (const item of items) {
            const localPath = path.join(localDir, item);
            const destinationPath = path.join(destinationPrefix, item).replace(/\\/g, '/');

            if (fs.statSync(localPath).isDirectory()) {
                const subUrls = await this.uploadDirectory(localPath, destinationPath);
                urls.push(...subUrls);
            } else {
                const url = await this.uploadFile(localPath, destinationPath);
                urls.push(url);
            }
        }

        return urls;
    }

    async listVideos() {
        if (this.mode === 's3') {
            const data = await this.s3Client.send(new ListObjectsV2Command({
                Bucket: process.env.S3_BUCKET
            }));
            return data.Contents
                .filter(obj => obj.Key.endsWith('/master.m3u8'))
                .map(obj => `https://${process.env.S3_BUCKET}.s3.ap-southeast-1.amazonaws.com/${obj.Key}`);
        } else {
            const hlsPath = path.join(process.cwd(), 'uploads');
            if (!fs.existsSync(hlsPath)) return [];

            const videos = [];
            const dirs = fs.readdirSync(hlsPath);
            
            for (const dir of dirs) {
                const masterPath = path.join(hlsPath, dir, 'master.m3u8');
                if (fs.existsSync(masterPath)) {
                    videos.push(`/uploads/${dir}/master.m3u8`);
                }
            }
            
            return videos;
        }
    }
}

module.exports = new StorageService();