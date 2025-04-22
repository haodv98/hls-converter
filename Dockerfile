FROM node:22-alpine

# Add tini for proper signal handling
RUN apk add --no-cache tini ffmpeg wget

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Create upload and HLS directories
RUN mkdir -p uploads hls

# Set proper permissions
RUN chown -R node:node /usr/src/app
USER node

EXPOSE 4000

CMD ["npm", "start"]