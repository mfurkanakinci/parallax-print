import { invertMat3, mulMat3 } from '../math/matrix3';
import { dot3, sub3 } from '../math/vector';
import type {
  ArtworkFrame,
  ArtworkSpec,
  AssetMetadata,
  CameraFrame,
  Mat3,
  Surface,
} from '../types';

export function buildArtworkFrame(
  artwork: ArtworkSpec,
  asset: AssetMetadata,
): ArtworkFrame {
  const height = artwork.heightSlope;
  const width = height * (asset.widthPx / asset.heightPx);
  const c = Math.cos((artwork.rotationDeg * Math.PI) / 180);
  const k = Math.sin((artwork.rotationDeg * Math.PI) / 180);
  const [cx, cy] = artwork.centerSlope;
  const imagePlaneToSource: Mat3 = [
    c / width,
    k / width,
    0.5 - (c * cx + k * cy) / width,
    k / height,
    -c / height,
    0.5 + (-k * cx + c * cy) / height,
    0,
    0,
    1,
  ];
  const sourceToImagePlane: Mat3 = [
    c * width,
    k * height,
    cx - 0.5 * (c * width + k * height),
    k * width,
    -c * height,
    cy + 0.5 * (c * height - k * width),
    0,
    0,
    1,
  ];
  return {
    assetId: artwork.assetId,
    centerSlope: artwork.centerSlope,
    heightSlope: height,
    widthSlope: width,
    rotationDeg: artwork.rotationDeg,
    sourceWidthPx: asset.widthPx,
    sourceHeightPx: asset.heightPx,
    imagePlaneToSource,
    sourceToImagePlane,
  };
}

export function buildSurfaceToImagePlane(
  surface: Surface,
  camera: CameraFrame,
): Mat3 {
  const rel = sub3(surface.originMm, camera.eyeMm);
  return [
    dot3(surface.axisU, camera.right),
    dot3(surface.axisV, camera.right),
    dot3(rel, camera.right),
    dot3(surface.axisU, camera.up),
    dot3(surface.axisV, camera.up),
    dot3(rel, camera.up),
    dot3(surface.axisU, camera.forward),
    dot3(surface.axisV, camera.forward),
    dot3(rel, camera.forward),
  ];
}

export function buildSurfaceHomography(
  surface: Surface,
  camera: CameraFrame,
  artwork: ArtworkFrame,
): Mat3 {
  return mulMat3(
    artwork.imagePlaneToSource,
    buildSurfaceToImagePlane(surface, camera),
  );
}

export function invertSurfaceHomography(m: Mat3): Mat3 | null {
  return invertMat3(m);
}
