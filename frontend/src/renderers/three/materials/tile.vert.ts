/**
 * The carved tile's vertex shader (3D-05; the board's per-instance flags in
 * 3D-07).
 *
 * One program draws every tile: the body geometry is built once (3D-04) and the
 * carved face comes from a per-instance atlas rect plus the instance matrix, so
 * 3D-07's board is one instanced draw call. Nothing here samples a texture; the
 * fragment stage owns the POM march.
 *
 * Frames. The mesh's local frame is +X width, +Y height, +Z out of the face
 * (3D-04's comment). The plate UV is V-down, matching the relief manifest's
 * y-down cells, and the tangent basis is `(T, B, N)` with T along +U and
 * B along +V. Both are transformed by the instance matrix's rotation only
 * (tiles are uniformly scaled), so the tangent space reaches the fragment stage
 * in world orientation.
 *
 * Instancing. three declares `instanceMatrix` itself when the mesh is an
 * `InstancedMesh`; this shader only has to use it. The per-instance attributes
 * are the atlas cell rect (vec4 `u0, v0, u1, v1`) and `aFlags`, the bitfield
 * 3D-07 packs (`boardMesh.INSTANCE_FLAG`: face-up, highlighted, dimmed). The
 * fragment stage tests the bits: face-up chooses between the carved face and the
 * blue back, and the other two shade the tile. A face-down tile is rotated by the
 * layout (3D-06), so its visible surface is the mesh's local -Z back plate and
 * needs no second geometry.
 */

export const TILE_VERTEX_SHADER = /* glsl */ `
attribute vec4 aAtlasRect;
attribute float aFlags;
attribute vec4 tangent;
attribute float faceZone;

varying vec2 vFaceUv;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
varying float vFaceZone;
varying float vFlags;

void main() {
  vec4 localPosition = vec4(position, 1.0);
  vec3 localNormal = normal;
  vec3 localTangent = tangent.xyz;
  float handedness = tangent.w;

  mat4 toWorld = modelMatrix;
#ifdef USE_INSTANCING
  toWorld = modelMatrix * instanceMatrix;
#endif

  vec4 worldPosition = toWorld * localPosition;
  mat3 rotation = mat3(toWorld);

  vec3 worldNormal = normalize(rotation * localNormal);
  vec3 worldTangent = normalize(rotation * localTangent);
  // Rotation is rigid, so this is only an exactness guard; it keeps the basis
  // orthonormal even if a future layout ever scales a tile non-uniformly.
  worldTangent = normalize(worldTangent - worldNormal * dot(worldNormal, worldTangent));
  vec3 worldBitangent = normalize(cross(worldNormal, worldTangent) * handedness);

  vFaceUv = vec2(
    mix(aAtlasRect.x, aAtlasRect.z, uv.x),
    mix(aAtlasRect.y, aAtlasRect.w, uv.y)
  );
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = worldNormal;
  vWorldTangent = worldTangent;
  vWorldBitangent = worldBitangent;
  vLocalPosition = localPosition.xyz;
  vFaceZone = faceZone;
  vFlags = aFlags;

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;
