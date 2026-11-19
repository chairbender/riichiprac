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
 *    **The displacement is scaled; the shading is not.** `uHeightScale` divides
 *    the engraved depth used by the march (the committed 0.55 mm map is the
 *    physical groove), because the approved 2.5D carved decals bake the same
 *    geometry as shading only — their camera is head-on, so the glyph never
 *    slides. A full-depth march at the pond's 37° moves a stroke edge by ~0.4 mm
 *    (a whole stroke width) and reads far deeper than the decals; the scale is
 *    the calibration between the two, and the normal and AO maps still carry the
 *    full carve. The offset is clamped to {@link POM_MAX_TEXELS} afterwards.
 * 3. **The carved look.** Albedo is `mix(ivory, pigment, paintMask)` — the
 *    committed albedo RGB is pigment only, white outside the mask, so the ivory
 *    body is what shows through. The sampled tangent normal is applied on the
 *    geometric plate normal; cavity AO multiplies the diffuse; the sampled
 *    roughness feeds one GGX lobe. Wrapped diffuse fakes the slab's
 *    translucency, and a second tight GGX lobe is the melamine clear coat the
 *    shells were baked with (`shell-spec.json`: coat 0.4 at roughness 0.1).
 *
 *    **Carve response.** The committed relief bake is a 0.655 mm, 40° V-wall
 *    with a broad 1.2 mm AO field, and the approved 2.5D decals are a 0.3 mm
 *    wall with tight occlusion: same engraving, much crisper shading. Two
 *    calibration uniforms close that gap without a rebake:
 *    `uNormalStrength` steepens the sampled wall (1.6 turns the map's 39°
 *    median lip into ~52°), and `uAoPower` curves the cavity (`ao^4` takes the
 *    lip's 0.66..0.99 into 0.19..0.96) so the groove's shadow side goes dark
 *    while the open face stays exactly 1. The key is one directional light, but
 *    the bake's key is a 40°-wide tube: `uKeySpreadDeg` integrates five samples
 *    of that source for the specular only, which is what produces the decals'
 *    bright lip rim. Measured against the decals in the unit's report.
 *    The white/blue split is `bake_shells.py`'s shader gate: everything behind
 *    0.3 x thickness is blue backing, so the side wall shows the 4.95 mm white
 *    band and the 11.55 mm blue band the shipped shells show.
 * 4. **The light-space self-shadow (3D-10).** The carve's walls occlude the
 *    key inside the groove. After the depth march resolves `uv`, a short march
 *    from that point **toward the key** samples the height field: at step `t`
 *    the ray's normalized depth is `surfaceDepth - t`, and the sampled point
 *    occludes it when its surface is higher. The reach is the same arithmetic
 *    as the parallax offset (the carve depth through the key's angle from the
 *    plate normal), clamped to `SHADOW_MAX_TEXELS`, so a grazing key cannot
 *    walk off the cell. The term multiplies the **key** irradiance only: the
 *    fill and ambient are not shadowed, and the ivory's open face (height 1)
 *    can never self-shadow its own flat surface because the ray starts at
 *    depth 0.
 *    `uShadowStrength`/`uShadowBias`/`uShadowSoftness` are the calibration.
 *    **0 is a first-class step count** (`compat`, `?debug=shadow-off`): the
 *    whole block is skipped and the plate shades exactly as 3D-05 shipped it.
 * 5. **Per-instance state (3D-07).** `vFlags` carries the board's bits:
 *    face-up selects the carved plate above (a face-down tile shows the blue
 *    back and samples nothing from the atlases), then a highlighted discard
 *    takes `uHighlightTint` at `uHighlightStrength` and a dimmed tsumogiri tile
 *    takes `uDimGain`, both after the BRDF. The values are `TILE_HIGHLIGHT`'s
 *    calibrated ranges, not debug colours.
 *
 * `POM_MAX_STEPS` is the compile-time loop bound (a constant so the compiler
 * unrolls it); the live count is the `uPomSteps` uniform, and **0 is a
 * first-class value**: the march is skipped entirely, the base height is used
 * and the plate shades exactly as the un-carved geometry with the normal, AO and
 * paint maps. That is the kill switch the tier map and `?debug=pom-off` use.
 * `SHADOW_MAX_STEPS` is the same bound for the self-shadow march.
 *
 * The debug modes are evaluated after shading, so the same program serves them,
 * and every branch assigns only `colour` — nothing upstream of it (the UV, the
 * normal, the geometry) can change, which is the "flood" property the
 * source-contract test pins:
 *   0 normal, 1 albedo, 2 height (1 - sampled height), 3 normal (tangent),
 *   4 POM steps taken (heat), 5 flags, 6 self-shadow visibility.
 */

export const TILE_FRAGMENT_SHADER = /* glsl */ `
#define POM_MAX_STEPS 32
#define SHADOW_MAX_STEPS 8

uniform sampler2D uAlbedo;
uniform sampler2D uNormalDepth;
uniform sampler2D uAoRoughness;

uniform float uPomSteps;
uniform float uCarveDepthUnits;
uniform float uHeightScale;
uniform vec2 uPlateUnits;
uniform vec2 uCellTexels;
uniform float uMaxParallaxTexels;
uniform float uDebug;

// 3D-10: the light-space self-shadow's live step count and calibration.
uniform float uShadowSteps;
uniform float uShadowDepthUnits;
uniform float uShadowMaxTexels;
uniform float uShadowStrength;
uniform float uShadowBias;
uniform float uShadowSoftness;

uniform vec3 uBodyIvory;
uniform vec3 uBodyBlue;
uniform float uBodyIvoryRoughness;
uniform float uBodyBlueRoughness;
uniform float uBackEdgeFraction;
uniform float uThicknessUnits;
uniform float uCoatFace;
uniform float uCoatBack;
uniform float uCoatRoughness;
uniform float uNormalStrength;
uniform float uAoPower;
uniform float uPaintCavityBlend;
uniform float uPaintSheen;
uniform float uKeySpreadDeg;

uniform vec3 uKeyDirection;
uniform vec3 uKeyColor;
uniform float uKeyIntensity;
uniform vec3 uFillSky;
uniform vec3 uFillGround;
uniform float uFillIntensity;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform float uSpecularF0;
uniform float uBodySpecularRoughness;
uniform vec2 uPlateLikeEdges;
uniform float uWrap;
uniform vec3 uHighlightTint;
uniform float uHighlightStrength;
uniform float uDimGain;

varying vec2 vFaceUv;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
varying float vFaceZone;
varying float vFlags;
varying float vLocalNormalZ;

const float PI = 3.141592653589793;
const float EPSILON = 1e-4;

vec3 decodeTangentNormal(vec3 encoded) {
  return normalize(encoded * 2.0 - 1.0);
}

/** An up-facing hemisphere fill weight for the world normal. */
float hemisphereWeight(vec3 worldNormal) {
  return clamp(0.5 + 0.5 * worldNormal.y, 0.0, 1.0);
}

/**
 * One GGX specular lobe (Smith-Schlick masking, Schlick Fresnel).
 */
vec3 ggxLobe(float ndl, float ndv, float ndh, float vdh, float roughness, float f0) {
  float alpha = max(roughness * roughness, 0.0016);
  float alphaSquared = alpha * alpha;
  float denominator = ndh * ndh * (alphaSquared - 1.0) + 1.0;
  float distribution = alphaSquared / (PI * denominator * denominator);
  float k = alpha * 0.5;
  float geometry =
    (ndv / (ndv * (1.0 - k) + k)) *
    (ndl / (ndl * (1.0 - k) + k));
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0);
  return vec3(distribution * geometry * fresnel /
    (4.0 * ndv * max(ndl, EPSILON)) * ndl);
}

/**
 * The specular of one light direction for the semigloss substrate plus the
 * clear coat. roughness is the surface's (sampled or body) roughness.
 */
vec3 specularFrom(vec3 L, vec3 N, vec3 V, float roughness, float coat) {
  vec3 halfVector = normalize(L + V);
  float ndl = clamp(dot(N, L), 0.0, 1.0);
  float ndv = clamp(dot(N, V), EPSILON, 1.0);
  float ndh = clamp(dot(N, halfVector), 0.0, 1.0);
  float vdh = clamp(dot(V, halfVector), 0.0, 1.0);
  return ggxLobe(ndl, ndv, ndh, vdh, roughness, uSpecularF0) +
    ggxLobe(ndl, ndv, ndh, vdh, uCoatRoughness, uSpecularF0) * coat;
}

/**
 * The bake's key is a wide tube (40 x 2.5 units at 56 away, i.e. ~40 deg of
 * source). A single directional sample would give a pinpoint highlight; five
 * samples across the source give the broad rim the decals show. Diffuse keeps
 * the single key direction: averaging it would only shift its brightness.
 */
vec3 keySpecular(vec3 N, vec3 V, float roughness, float coat) {
  vec3 L = normalize(uKeyDirection);
  vec3 reference = abs(L.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 ax = normalize(cross(L, reference));
  vec3 ay = cross(L, ax);
  float spread = radians(uKeySpreadDeg);
  vec2 offsets[5];
  offsets[0] = vec2(0.0, 0.0);
  offsets[1] = vec2(1.0, 0.0);
  offsets[2] = vec2(-1.0, 0.0);
  offsets[3] = vec2(0.0, 1.0);
  offsets[4] = vec2(0.0, -1.0);
  vec3 total = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec3 sampleDirection = normalize(L + ax * offsets[i].x * spread + ay * offsets[i].y * spread);
    total += specularFrom(sampleDirection, N, V, roughness, coat);
  }
  return total * 0.2;
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
  // The key, in world and in the plate's tangent frame. The tangent-frame copy
  // is taken with the **geometric** normal (before the carve perturbs N below),
  // so a groove wall's slope cannot bend the shadow's march direction.
  vec3 lightDirection = normalize(uKeyDirection);
  vec3 lightTangent = vec3(dot(lightDirection, T), dot(lightDirection, B), dot(lightDirection, N));

  // The per-instance flag bits from boardMesh.INSTANCE_FLAG (1 face-up,
  // 2 highlighted, 4 dimmed). Decoded as float bits: the values are small
  // integers, so the exact arithmetic is safe on every driver.
  float flagFaceUp = mod(vFlags, 2.0);
  float flagHighlighted = mod(floor(vFlags * 0.5), 2.0);
  float flagDimmed = mod(floor(vFlags * 0.25), 2.0);

  bool onPlate = vFaceZone > 0.5 && flagFaceUp > 0.5;
  // The shell baker's white/blue gate (bake_shells.py): everything behind
  // 0.3 x thickness is the blue backing, so the side wall carries a 4.95 mm
  // ivory band in front of an 11.55 mm blue one. Local +Z is the face normal.
  float backCut = (uBackEdgeFraction - 0.5) * uThicknessUnits;
  bool blueBody = vLocalPosition.z < backCut;

  vec3 albedo = blueBody ? uBodyBlue : uBodyIvory;
  float roughness = blueBody ? uBodyBlueRoughness : uBodyIvoryRoughness;
  float coat = blueBody ? uCoatBack : uCoatFace;
  float cavity = 1.0;
  float vPaintMaskOut = 0.0;
  vec3 tangentNormal = vec3(0.0, 0.0, 1.0);

  // The base height is always sampled: the height debug view and the POM
  // "un-carved" path both need it, and POM off must not change this value.
  vec4 baseSample = textureGrad(uNormalDepth, vFaceUv, dUvDx, dUvDy);
  float baseHeight = baseSample.a;
  float stepsTaken = 0.0;
  // 3D-10: the key's visibility at the resolved carve point. 1 everywhere the
  // shadow march does not run (the body, a face-down tile, steps 0).
  float shadowVisibility = 1.0;

  if (onPlate) {
    vec2 uv = vFaceUv;

    if (uPomSteps > 0.5) {
      // Full-depth offset in atlas UV: the lateral part of the view ray, scaled
      // by the engraved depth (times the calibration scale) and divided by the
      // plate's own width/height so a non-square plate keeps the ray's true
      // direction.
      float depthUnits = uCarveDepthUnits * uHeightScale;
      vec2 rayDir = vec2(
        -depthUnits * viewTangent.x / max(viewTangent.z, 0.08) / uPlateUnits.x,
        -depthUnits * viewTangent.y / max(viewTangent.z, 0.08) / uPlateUnits.y
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
    // The map's wall is 40 deg; the approved decals' is ~59 deg. Steepen the
    // sampled normal so the plate reads like the sharper engraving, without a
    // rebake. A flat (open face) normal is unchanged: 0 x strength is 0.
    tangentNormal = normalize(vec3(tangentNormal.xy * uNormalStrength, tangentNormal.z));
    N = normalize(T * tangentNormal.x + B * tangentNormal.y + N * tangentNormal.z);
    albedo = mix(uBodyIvory, albedoSample.rgb, albedoSample.a);
    vPaintMaskOut = albedoSample.a;
    roughness = aoSample.g;
    // The committed AO only spans 0.66..1.0 on the lip. The ivory lip takes a
    // power curve (the open face stays exactly 1, the wall drops); the painted
    // groove keeps almost all of the atlas's own AO, because the decal's paint
    // is a glossy lacquer that reads bright, not a shadow.
    float lipCavity = pow(aoSample.r, uAoPower);
    cavity = mix(lipCavity, aoSample.r, albedoSample.a * uPaintCavityBlend);

    // (4) The light-space self-shadow. The light's direction in the plate's
    // tangent frame; its lateral part is what walks the height field. The
    // reach is the same plate/texel conversion as the parallax offset, so the
    // two bounds are one arithmetic: depth through the ray's tangent angle.
    if (uShadowSteps > 0.5) {
      // Only a light above the plate can be occluded by it. A light behind the
      // plate contributes nothing to the key anyway (wrapped diffuse clamps).
      if (lightTangent.z > 0.05) {
        vec2 shadowRay = vec2(
          uShadowDepthUnits * lightTangent.x / lightTangent.z / uPlateUnits.x,
          uShadowDepthUnits * lightTangent.y / lightTangent.z / uPlateUnits.y
        );
        float shadowTexels = length(shadowRay * uCellTexels);
        if (shadowTexels > uShadowMaxTexels) {
          shadowRay *= uShadowMaxTexels / shadowTexels;
        }
        // surfaceDepth is normalized (0 open face, 1 groove floor). Marching
        // toward the key lowers the ray's depth by one full unit over the
        // reach, so the comparison is exact depth, not a fudge.
        float surfaceDepth = 1.0 - normalSample.a;
        float occlusion = 0.0;
        for (int step = 1; step <= SHADOW_MAX_STEPS; step++) {
          if (float(step) > uShadowSteps) break;
          float t = float(step) / uShadowSteps;
          float sampleDepth = 1.0 - textureGrad(
            uNormalDepth, uv + shadowRay * t, dUvDx, dUvDy
          ).a;
          float gap = (surfaceDepth - t) - sampleDepth - uShadowBias;
          occlusion = max(occlusion, clamp(gap / max(uShadowSoftness, 1e-4), 0.0, 1.0));
        }
        shadowVisibility = 1.0 - uShadowStrength * occlusion;
      }
    }
  }

  // Wrapped Lambert diffuse (translucent resin) + one GGX key highlight + a
  // hemisphere fill + a weak ambient, exactly as lighting.ts predicts.
  float wrapDiffuse = clamp((dot(N, lightDirection) + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  vec3 keyIrradiance = uKeyColor * uKeyIntensity * wrapDiffuse * shadowVisibility;
  vec3 fillIrradiance = mix(uFillGround, uFillSky, hemisphereWeight(N)) * uFillIntensity;
  vec3 ambientIrradiance = uAmbientColor * uAmbientIntensity;
  vec3 diffuse = albedo * (keyIrradiance + fillIrradiance + ambientIrradiance) / PI * cavity;

  // The shell's finish belongs to the flat face and backing only. On the bevel
  // ring the same finish would render as a one-tile-wide white rim wherever the
  // view ray crosses the key's half-vector (see lighting.BODY_SPECULAR), so the
  // curved band takes a broad, coat-free lobe instead.
  float plateLike = smoothstep(uPlateLikeEdges.x, uPlateLikeEdges.y, abs(vLocalNormalZ));
  float bodyRoughness = mix(uBodySpecularRoughness, roughness, plateLike);
  float bodyCoat = coat * plateLike;
  // The self-shadow is a **diffuse** occlusion (above). The key's specular is
  // deliberate: 3D-05 calibrated the broad lip rim against the approved decals,
  // and shadowing the lobe would darken the light-facing wall that produces it.
  // The groove's depth reads in the diffuse, which is where the calibration
  // numbers in 3D-10 were measured.
  vec3 specular = uKeyColor * uKeyIntensity * keySpecular(N, V, bodyRoughness, bodyCoat);

  vec3 colour = diffuse + specular;
  // The baked lacquer's broad sheen (see PAINT_SHEEN): painted pixels only, and
  // only where the plate was sampled.
  colour += vec3(uPaintSheen) * vPaintMaskOut * clamp(cavity, 0.0, 1.0);

  // Per-instance state (3D-07). A highlighted discard — the newest tile of a
  // seat a call/ron offer names — warms and brightens by uHighlightTint; a
  // dimmed tsumogiri discard darkens by uDimGain. Both are calibrated ranges
  // (TILE_HIGHLIGHT), not debug colours, and neither touches the probes: the
  // hero tiles carry no flags.
  colour = mix(colour, colour * uHighlightTint, flagHighlighted * uHighlightStrength);
  colour *= mix(1.0, uDimGain, flagDimmed);

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
    } else if (uDebug < 5.5) {
      // debug=flags: the shader's own branch state per pixel — R face-up,
      // G blue body (else ivory), B carved-plate zone. The glint probe
      // (glintProbe.ts) uses it to attribute a bright pixel to the surface that
      // drew it instead of guessing from geometry.
      colour = vec3(flagFaceUp, blueBody ? 1.0 : 0.0, vFaceZone);
    } else if (uDebug < 6.5) {
      // debug=shadow: R the key's visibility after the self-shadow (1 lit,
      // 0 occluded), G the shadow term after uShadowStrength (0 unshadowed).
      // Read against the albedo/height views to see which wall did the
      // occluding; nothing else in the frame changes.
      colour = vec3(shadowVisibility, uShadowStrength * (1.0 - shadowVisibility), 0.0);
    }
  }

  gl_FragColor = linearToOutputTexel(vec4(colour, 1.0));
}
`;
