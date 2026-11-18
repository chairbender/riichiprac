/**
 * The carved tile's fragment shader (3D-05).
 *
 * What it computes, in order, and why:
 *
 * 1. **Derivatives first, before any branch.** `dFdx`/`dFdy` of the face UV are
 *    taken unconditionally at the top of `main`. Every later sample is
 *    `textureGrad(..., dUvDx, dUvDy)` with those base gradients, because the
 *    POM march samples inside a loop and inside control flow where implicit
 *    derivatives are undefined. This is the "derivative guard": it is the first
 *    statement in the shader and a unit test fails if it ever moves below the
 *    first `if`.
 * 2. **The tangent-space height march.** The carve is 3D-04's flat plate plus
 *    this: the committed `face_normal_depth` alpha is the height (1 open face,
 *    0 engraving floor), and the ray from the eye to the plate is walked in
 *    `uPomSteps` linear layers. The first layer that falls below the sampled
 *    surface is refined once by the secant step between the last two samples.
 *    The full-depth offset is clamped to {@link POM_MAX_TEXELS} by the material
 *    uniform so no view can displace more than the 8-texel budget (3D-05).
 * 3. **The carved look.** Albedo is `mix(ivory, pigment, paintMask)` — the
 *    committed albedo RGB is pigment only, white outside the mask, so the ivory
 *    body is what shows through. The sampled tangent normal is applied on the
 *    geometric plate normal; cavity AO multiplies the diffuse; the sampled
 *    roughness feeds one GGX lobe. Wrapped diffuse fakes the slab's
 *    translucency. The blue back and the ivory bevel share the same BRDF with
 *    the body colours.
 *
 * `POM_MAX_STEPS` is the compile-time loop bound (a constant so the compiler
 * unrolls it); the live count is the `uPomSteps` uniform, and **0 is a
 * first-class value**: the march is skipped entirely, the base height is used
 * and the plate shades exactly as the un-carved geometry with the normal, AO and
 * paint maps. That is the kill switch the tier map and `?debug=pom-off` use.
 *
 * The debug modes are evaluated after shading, so the same program serves them
 * (3D-10 extends this set):
 *   0 normal, 1 albedo, 2 height (1 - sampled height), 3 normal (tangent),
 *   4 POM steps taken (heat), 5/6 unused codes.
 */

export const TILE_FRAGMENT_SHADER = /* glsl */ `
#define POM_MAX_STEPS 32

uniform sampler2D uAlbedo;
uniform sampler2D uNormalDepth;
uniform sampler2D uAoRoughness;

uniform float uPomSteps;
uniform float uCarveDepthUnits;
uniform vec2 uPlateUnits;
uniform vec2 uCellTexels;
uniform float uMaxParallaxTexels;
uniform float uDebug;

uniform vec3 uBodyIvory;
uniform vec3 uBodyBlue;
uniform float uBodyIvoryRoughness;
uniform float uBodyBlueRoughness;

uniform vec3 uKeyDirection;
uniform vec3 uKeyColor;
uniform float uKeyIntensity;
uniform vec3 uFillSky;
uniform vec3 uFillGround;
uniform float uFillIntensity;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform float uSpecularF0;
uniform float uWrap;

varying vec2 vFaceUv;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
varying vec3 vWorldPosition;
varying vec3 vLocalNormal;
varying float vFaceZone;
varying float vFaceUp;

const float PI = 3.141592653589793;
const float EPSILON = 1e-4;

vec3 decodeTangentNormal(vec3 encoded) {
  return normalize(encoded * 2.0 - 1.0);
}

/** An up-facing hemisphere fill weight for the world normal. */
float hemisphereWeight(vec3 worldNormal) {
  return clamp(0.5 + 0.5 * worldNormal.y, 0.0, 1.0);
}

void main() {
  // (1) The derivative guard. Nothing before this line, no branch above it.
  vec2 dUvDx = dFdx(vFaceUv);
  vec2 dUvDy = dFdy(vFaceUv);

  vec3 N = normalize(vWorldNormal);
  vec3 T = normalize(vWorldTangent);
  vec3 B = normalize(vWorldBitangent);
  vec3 V = normalize(cameraPosition - vWorldPosition);
  // The view ray in the plate's tangent space (x = +U, y = +V, z = out).
  vec3 viewTangent = vec3(dot(V, T), dot(V, B), dot(V, N));

  bool onPlate = vFaceZone > 0.5 && vFaceUp > 0.5;
  bool onBlueBack = vLocalNormal.z < -0.5;

  vec3 albedo = onBlueBack ? uBodyBlue : uBodyIvory;
  float roughness = onBlueBack ? uBodyBlueRoughness : uBodyIvoryRoughness;
  float cavity = 1.0;
  vec3 tangentNormal = vec3(0.0, 0.0, 1.0);

  // The base height is always sampled: the height debug view and the POM
  // "un-carved" path both need it, and POM off must not change this value.
  vec4 baseSample = textureGrad(uNormalDepth, vFaceUv, dUvDx, dUvDy);
  float baseHeight = baseSample.a;
  float stepsTaken = 0.0;

  if (onPlate) {
    vec2 uv = vFaceUv;

    if (uPomSteps > 0.5) {
      // Full-depth offset in atlas UV: the lateral part of the view ray, scaled
      // by the carve depth and divided by the plate's own width/height so a
      // non-square plate keeps the ray's true direction.
      vec2 rayDir = vec2(
        -uCarveDepthUnits * viewTangent.x / max(viewTangent.z, 0.08) / uPlateUnits.x,
        -uCarveDepthUnits * viewTangent.y / max(viewTangent.z, 0.08) / uPlateUnits.y
      );
      // The 8-texel parallax bound: clamp the full-depth displacement, not the
      // per-step one, so direction is preserved and cost is unchanged.
      float texelLength = length(rayDir * uCellTexels);
      if (texelLength > uMaxParallaxTexels) {
        rayDir *= uMaxParallaxTexels / texelLength;
      }

      float previousT = 0.0;
      float previousDiff = baseHeight - 1.0;
      for (int step = 1; step <= POM_MAX_STEPS; step++) {
        if (float(step) > uPomSteps) break;
        float t = float(step) / uPomSteps;
        vec2 sampleUv = vFaceUv + rayDir * t;
        float surfaceDepth = 1.0 - textureGrad(uNormalDepth, sampleUv, dUvDx, dUvDy).a;
        float difference = t - surfaceDepth;
        stepsTaken += 1.0;
        if (difference >= 0.0) {
          // One secant refinement between the last two layers: the crossing is
          // linear in t over a layer, which is exact for a linear ramp and
          // tight enough that a 12-step march shows no stair-stepping.
          float span = difference - previousDiff;
          float k = span > 1e-5 ? clamp(-previousDiff / span, 0.0, 1.0) : 0.0;
          uv = vFaceUv + rayDir * mix(previousT, t, k);
          break;
        }
        previousT = t;
        previousDiff = difference;
      }
    }

    vec4 normalSample = textureGrad(uNormalDepth, uv, dUvDx, dUvDy);
    vec4 albedoSample = textureGrad(uAlbedo, uv, dUvDx, dUvDy);
    vec4 aoSample = textureGrad(uAoRoughness, uv, dUvDx, dUvDy);

    tangentNormal = decodeTangentNormal(normalSample.rgb);
    N = normalize(T * tangentNormal.x + B * tangentNormal.y + N * tangentNormal.z);
    albedo = mix(uBodyIvory, albedoSample.rgb, albedoSample.a);
    roughness = aoSample.g;
    cavity = aoSample.r;
  }

  // Wrapped Lambert diffuse (translucent resin) + one GGX key highlight + a
  // hemisphere fill + a weak ambient, exactly as lighting.ts predicts.
  vec3 lightDirection = normalize(uKeyDirection);
  float wrapDiffuse = clamp((dot(N, lightDirection) + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  vec3 keyIrradiance = uKeyColor * uKeyIntensity * wrapDiffuse;
  vec3 fillIrradiance = mix(uFillGround, uFillSky, hemisphereWeight(N)) * uFillIntensity;
  vec3 ambientIrradiance = uAmbientColor * uAmbientIntensity;
  vec3 diffuse = albedo * (keyIrradiance + fillIrradiance + ambientIrradiance) / PI * cavity;

  vec3 halfVector = normalize(lightDirection + V);
  float ndl = clamp(dot(N, lightDirection), 0.0, 1.0);
  float ndv = clamp(dot(N, V), EPSILON, 1.0);
  float ndh = clamp(dot(N, halfVector), 0.0, 1.0);
  float vdh = clamp(dot(V, halfVector), 0.0, 1.0);
  float alpha = max(roughness * roughness, 0.0016);
  float alphaSquared = alpha * alpha;
  float distributionDenominator = ndh * ndh * (alphaSquared - 1.0) + 1.0;
  float distribution = alphaSquared / (PI * distributionDenominator * distributionDenominator);
  float k = alpha * 0.5;
  float geometry =
    (ndv / (ndv * (1.0 - k) + k)) *
    (ndl / (ndl * (1.0 - k) + k));
  vec3 fresnel = vec3(uSpecularF0) + (1.0 - uSpecularF0) * pow(1.0 - vdh, 5.0);
  vec3 specular =
    uKeyColor * uKeyIntensity * distribution * geometry * fresnel /
    (4.0 * ndv * max(ndl, EPSILON)) * ndl;

  vec3 colour = diffuse + specular;

  if (uDebug > 0.5) {
    if (uDebug < 1.5) {
      colour = albedo;
    } else if (uDebug < 2.5) {
      colour = vec3(1.0 - baseHeight);
    } else if (uDebug < 3.5) {
      colour = tangentNormal * 0.5 + 0.5;
    } else if (uDebug < 4.5) {
      float ratio = uPomSteps > 0.5 ? stepsTaken / uPomSteps : 0.0;
      colour = vec3(ratio, 1.0 - ratio, 0.0);
    }
  }

  gl_FragColor = linearToOutputTexel(vec4(colour, 1.0));
}
`;
