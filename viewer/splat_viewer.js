import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const viewer = new GaussianSplats3D.Viewer({
    'initialCameraPosition': [-2.0, 1.0, 3.0],
    'initialCameraLookAt': [0.0, 1.0, 0.0],
    'halfPrecision': true
});

viewer.addSplatScene('/data/3dgs_output/scene.splat', {
    'showLoadingUI': false,
    'position': [0, 0, 0],
    'rotation': [0, 0, 0, 1],
    'scale': [1, 1, 1]
}).then(() => {
    document.getElementById('loading').style.display = 'none';
    viewer.start();
}).catch((error) => {
    document.getElementById('loading').innerHTML = `Error loading scene: ${error}`;
    console.error("Splat loading error:", error);
});
