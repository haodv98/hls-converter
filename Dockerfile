FROM node:22-alpine

# Install FFmpeg and other dependencies
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Create upload and HLS directories
RUN mkdir -p uploads hls

EXPOSE 4000

CMD ["npm", "start"]