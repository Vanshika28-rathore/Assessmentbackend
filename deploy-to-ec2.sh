#!/bin/bash

# EC2 Deployment Script
# This script pulls latest code and restarts the backend server

echo "🚀 Starting EC2 deployment..."

# Navigate to backend directory
cd /home/ubuntu/aws-assessments-backend || cd /home/ec2-user/aws-assessments-backend

# Pull latest code from GitHub
echo "📥 Pulling latest code from GitHub..."
git pull origin main

# Install dependencies (if package.json changed)
echo "📦 Installing dependencies..."
npm install

# Restart the backend server using PM2
echo "🔄 Restarting backend server..."
pm2 restart all

# Show PM2 status
echo "✅ Deployment complete! Server status:"
pm2 status

echo "🎉 Deployment finished!"
