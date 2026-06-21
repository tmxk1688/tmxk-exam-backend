const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadFile(buffer, folder, filename) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return null;
  }
  try {
    const result = await cloudinary.uploader.upload(buffer, {
      folder: `exam/${folder}`,
      public_id: filename,
      resource_type: 'auto'
    });
    return result.secure_url;
  } catch (err) {
    console.error('Cloudinary upload error:', err.message);
    return null;
  }
}

async function deleteFile(publicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
}

module.exports = { uploadFile, deleteFile };
