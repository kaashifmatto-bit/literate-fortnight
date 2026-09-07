import fs from 'fs';
import path from 'path';

// Helper script to create public/panoramas folder and place README
const panoramasDir = path.resolve('public/panoramas');

if (!fs.existsSync(panoramasDir)) {
  fs.mkdirSync(panoramasDir, { recursive: true });
}

fs.writeFileSync(
  path.join(panoramasDir, 'README.txt'),
  `Place your 360° equirectangular JPG panorama images in this folder:
- reception.jpg
- lobby.jpg
- office.jpg
- conference.jpg
- lounge.jpg

The viewer automatically falls back to procedural high-definition 360° panoramas if local image files are not present.`
);

console.log('Public panoramas directory created successfully.');
