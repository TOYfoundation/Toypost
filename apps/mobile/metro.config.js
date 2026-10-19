// Expo erkennt npm-Workspaces automatisch; das gemeinsame Paket wird aus packages/shared gebündelt.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
