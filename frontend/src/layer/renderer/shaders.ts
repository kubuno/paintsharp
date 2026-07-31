// GLSL sources for the Layer compositing and display passes.
// Extracted verbatim from LayerEditorPage during the layer/ refactor —
// no behavioural change.

// Composite pass: NO Y-flip. Layer textures store doc-top at t=0.
// Each ping-pong step is consistent → no alternating flip.
export const VERT_COMP = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos*.5+.5; gl_Position=vec4(aPos,0,1); }`

// Display pass: Y-flip so that vUv.y=0 maps to screen-top which reads fb-bottom=doc-top.
export const VERT_DISP = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos*.5+.5; vUv.y=1.-vUv.y; gl_Position=vec4(aPos,0,1); }`

export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uBase, uLayer, uMask, uClip;
uniform float uOpacity;
uniform int uMode;
uniform int uHasMask;
uniform int uHasClip;
in vec2 vUv; out vec4 fragColor;
vec3 fScreen(vec3 b,vec3 l){return b+l-b*l;}
vec3 fOvl(vec3 b,vec3 l){
  return vec3(
    b.r<.5?2.*b.r*l.r:1.-2.*(1.-b.r)*(1.-l.r),
    b.g<.5?2.*b.g*l.g:1.-2.*(1.-b.g)*(1.-l.g),
    b.b<.5?2.*b.b*l.b:1.-2.*(1.-b.b)*(1.-l.b));
}
vec3 fSoft(vec3 b,vec3 l){
  return mix(2.*b*l+b*b*(1.-2.*l), 2.*b*(1.-l)+sqrt(b)*(2.*l-1.), step(.5,l));
}
vec3 fVivid(vec3 b,vec3 l){
  return vec3(
    l.r<.5? 1.-min((1.-b.r)/max(2.*l.r,1e-4),1.) : min(b.r/max(2.*(1.-l.r),1e-4),1.),
    l.g<.5? 1.-min((1.-b.g)/max(2.*l.g,1e-4),1.) : min(b.g/max(2.*(1.-l.g),1e-4),1.),
    l.b<.5? 1.-min((1.-b.b)/max(2.*l.b,1e-4),1.) : min(b.b/max(2.*(1.-l.b),1e-4),1.));
}
vec3 fPin(vec3 b,vec3 l){
  return vec3(
    l.r<.5? min(b.r,2.*l.r) : max(b.r,2.*(l.r-.5)),
    l.g<.5? min(b.g,2.*l.g) : max(b.g,2.*(l.g-.5)),
    l.b<.5? min(b.b,2.*l.b) : max(b.b,2.*(l.b-.5)));
}
// Non-separable (HSL) blends — hue / saturation / color / luminosity.
float bLum(vec3 c){return dot(c,vec3(0.3,0.59,0.11));}
vec3 clipColor(vec3 c){
  float l=bLum(c), n=min(min(c.r,c.g),c.b), x=max(max(c.r,c.g),c.b);
  if(n<0.) c=l+(c-l)*l/max(l-n,1e-5);
  if(x>1.) c=l+(c-l)*(1.-l)/max(x-l,1e-5);
  return c;
}
vec3 setLum(vec3 c,float l){return clipColor(c+(l-bLum(c)));}
float bSat(vec3 c){return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
vec3 setSat(vec3 c,float s){
  float mn=min(min(c.r,c.g),c.b), mx=max(max(c.r,c.g),c.b), rg=mx-mn;
  return rg>0.? (c-mn)/rg*s : vec3(0.);
}
void main(){
  vec4 base=texture(uBase,vUv), lay=texture(uLayer,vUv);
  // Erase mode: reduce base alpha by stroke alpha (opacity already baked into lay.a)
  if(uMode==10){
    float newA=max(0.,base.a-lay.a);
    fragColor=vec4(base.a>.001?base.rgb:vec3(0.),newA); return;
  }
  if(uHasMask==1) lay.a*=texture(uMask,vUv).r; // layer mask: white=visible, black=hidden
  if(uHasClip==1) lay.a*=texture(uClip,vUv).a; // clipping mask: confined to clip base's alpha
  lay.a*=uOpacity;
  vec3 bl;
  if(uMode==1) bl=base.rgb*lay.rgb;
  else if(uMode==2) bl=fScreen(base.rgb,lay.rgb);
  else if(uMode==3) bl=fOvl(base.rgb,lay.rgb);
  else if(uMode==4) bl=min(base.rgb,lay.rgb);
  else if(uMode==5) bl=max(base.rgb,lay.rgb);
  else if(uMode==6) bl=abs(base.rgb-lay.rgb);
  else if(uMode==7) bl=clamp(base.rgb/max(1.-lay.rgb,.001),0.,1.);
  else if(uMode==8) bl=1.-clamp((1.-base.rgb)/max(lay.rgb,.001),0.,1.);
  else if(uMode==9) bl=fSoft(base.rgb,lay.rgb);
  else if(uMode==11) bl=fOvl(lay.rgb,base.rgb);                       // hard light
  else if(uMode==12) bl=min(base.rgb+lay.rgb,1.);                     // linear dodge (add)
  else if(uMode==13) bl=max(base.rgb+lay.rgb-1.,0.);                  // linear burn
  else if(uMode==14) bl=fVivid(base.rgb,lay.rgb);                     // vivid light
  else if(uMode==15) bl=clamp(base.rgb+2.*lay.rgb-1.,0.,1.);          // linear light
  else if(uMode==16) bl=fPin(base.rgb,lay.rgb);                       // pin light
  else if(uMode==17) bl=base.rgb+lay.rgb-2.*base.rgb*lay.rgb;         // exclusion
  else if(uMode==18) bl=max(base.rgb-lay.rgb,0.);                     // subtract
  else if(uMode==19) bl=clamp(base.rgb/max(lay.rgb,vec3(1e-4)),0.,1.);// divide
  else if(uMode==20) bl=setLum(setSat(lay.rgb,bSat(base.rgb)),bLum(base.rgb)); // hue
  else if(uMode==21) bl=setLum(setSat(base.rgb,bSat(lay.rgb)),bLum(base.rgb)); // saturation
  else if(uMode==22) bl=setLum(lay.rgb,bLum(base.rgb));               // color
  else if(uMode==23) bl=setLum(base.rgb,bLum(lay.rgb));               // luminosity
  else bl=lay.rgb;
  float a=lay.a+base.a*(1.-lay.a);
  vec3 c=a<.0001?vec3(0.):(bl*lay.a+base.rgb*base.a*(1.-lay.a))/a;
  fragColor=vec4(c,a);
}`

/**
 * Adjustment-layer pass: a full-screen operator applied to everything composited
 * so far, which is what makes an adjustment layer non-destructive — the layers
 * below keep their pixels, only the running composite is transformed.
 *
 * Works on straight (unpremultiplied) RGBA and leaves alpha untouched: an
 * adjustment must never change the shape of what is underneath it.
 */
export const FRAG_ADJUST = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform int   uKind;
uniform int   uHasMask;
uniform float uOpacity;
uniform vec4  uP;      // per-kind parameters
uniform vec3  uColor;  // photo filter / colour parameters
in vec2 vUv; out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0., -1./3., 2./3., -1.);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6. * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1., 2./3., 1./3., 3.);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6. - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0., 1.), c.y);
}

void main(){
  vec4 s = texture(uTex, vUv);
  vec3 c = s.rgb;

  if(uKind==1){                                  // brightness / contrast
    c += uP.x;
    c = (c - 0.5) * (1.0 + uP.y) + 0.5;
  } else if(uKind==2){                           // exposure (stops) + offset
    c = c * pow(2.0, uP.x) + uP.y;
  } else if(uKind==3){                           // hue / saturation / lightness
    vec3 h = rgb2hsv(c);
    h.x = fract(h.x + uP.x);
    h.y = clamp(h.y * (1.0 + uP.y), 0., 1.);
    c = hsv2rgb(h);
    c = uP.z >= 0.0 ? mix(c, vec3(1.), uP.z) : mix(c, vec3(0.), -uP.z);
  } else if(uKind==4){                           // vibrance: spares already-saturated pixels
    float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
    float sat = mx - mn;
    float amt = uP.x * (1.0 - sat);
    float l = dot(c, LUMA);
    c = mix(vec3(l), c, 1.0 + amt);
  } else if(uKind==5){                           // black & white with channel weights
    float l = dot(c, normalize(max(uColor, vec3(1e-3))));
    c = vec3(l);
  } else if(uKind==6){                           // invert
    c = 1.0 - c;
  } else if(uKind==7){                           // posterize
    float lv = max(2.0, uP.x);
    c = floor(c * lv) / (lv - 1.0);
  } else if(uKind==8){                           // threshold
    float l = dot(c, LUMA);
    c = vec3(step(uP.x, l));
  } else if(uKind==9){                           // photo filter
    float l = dot(c, LUMA);
    c = mix(c, uColor * (l / max(dot(uColor, LUMA), 1e-3)), uP.x);
  } else if(uKind==10){                          // levels: in black / in white / gamma
    c = clamp((c - uP.x) / max(uP.y - uP.x, 1e-3), 0., 1.);
    c = pow(c, vec3(1.0 / max(uP.z, 1e-3)));
  } else if(uKind==11){                          // colour balance (single RGB offset)
    c += uColor;
  }

  c = clamp(c, 0.0, 1.0);
  float k = uOpacity;
  if(uHasMask==1) k *= texture(uMask, vUv).r;
  fragColor = vec4(mix(s.rgb, c, k), s.a);
}`

export const FRAG_DISPLAY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOffset, uScale, uViewport;
uniform float uRot;
in vec2 vUv; out vec4 fragColor;

// Scale-aware resampler, three regimes chosen by fp (texels per device pixel):
//  • fp ≤ ~1 (100% and any magnification): "sharp bilinear" / texel anti-aliasing —
//    the sample is snapped to texel centres but the boundary between two texels is
//    anti-aliased over exactly one screen pixel. At exactly 100% this is a 1:1
//    pixel-perfect blit (the old code fell through to the supersampler at fp==1.0,
//    which box-blurred the canvas at the single most-used zoom level).
//  • 1 < fp ≤ 4 (zoom 25%..100%): 4×4 supersample at LOD 0 — each tap covers at
//    most one texel, so the average is a true box filter. Crisper than the old
//    trilinear-mip taps AND mip-free, so the doc mipchain no longer has to be
//    regenerated every brush-stroke frame (that was the main paint-time cost).
//  • fp > 4 (far zoom-out): 4×4 supersample through the mip chain (textureGrad).
// dx/dy are dFdx/dFdy(uv), passed from main() so derivatives stay in uniform flow.
vec4 sampleDoc(vec2 uv, vec2 dx, vec2 dy){
  vec2 ts=vec2(textureSize(uTex,0));
  float fp=max(length(dx*ts), length(dy*ts)); // texels covered per device pixel
  if(fp<=1.001){
    vec2 px=uv*ts;
    vec2 fl=floor(px)+0.5;
    vec2 w=max((abs(dx)+abs(dy))*ts, vec2(1e-5)); // = fwidth(px), one screen px in texels
    vec2 aa=clamp((px-fl)/w, -0.5, 0.5);
    return textureLod(uTex, (fl+aa)/ts, 0.0);     // LINEAR mag turns the offset into a 1px AA edge
  }
  // Both minification regimes average in PREMULTIPLIED alpha: the doc texture holds
  // straight (unpremultiplied) RGBA, and a transparent texel stores rgb=0, so a
  // plain average darkens colour toward black along transparent edges (the classic
  // halo/fringe). Accumulating rgb·a and dividing by Σa reconstructs the correct
  // edge colour at no extra tap cost.
  vec4 acc=vec4(0.0);
  if(fp<=4.0){
    for(int j=0;j<4;j++) for(int i=0;i<4;i++){
      vec2 o=(vec2(float(i),float(j))+0.5)*0.25-0.5;
      vec4 c=textureLod(uTex, uv+dx*o.x+dy*o.y, 0.0);
      acc+=vec4(c.rgb*c.a, c.a);
    }
  } else {
    vec2 sdx=dx*0.25, sdy=dy*0.25;
    for(int j=0;j<4;j++) for(int i=0;i<4;i++){
      vec2 o=(vec2(float(i),float(j))+0.5)*0.25-0.5;
      vec4 c=textureGrad(uTex, uv+dx*o.x+dy*o.y, sdx, sdy);
      acc+=vec4(c.rgb*c.a, c.a);
    }
  }
  float a=acc.a*0.0625;
  return vec4(acc.a>1e-5? acc.rgb/acc.a : vec3(0.0), a);
}

void main(){
  vec2 sp=vUv*uViewport;
  // Rotate the screen point about the viewport centre (inverse, to sample the doc).
  vec2 cv=uViewport*0.5;
  float cs=cos(-uRot), sn=sin(-uRot);
  vec2 d=sp-cv;
  vec2 base=cv+vec2(d.x*cs-d.y*sn, d.x*sn+d.y*cs);
  vec2 tc=(base-uOffset)/uScale;
  // Derivatives in uniform control flow (before the edge discard) so the footprint
  // and mip LOD stay defined right up to the doc border.
  vec2 tdx=dFdx(tc), tdy=dFdy(tc);
  if(tc.x<0.||tc.x>1.||tc.y<0.||tc.y>1.){
    float ck=mod(floor(sp.x/14.)+floor(sp.y/14.),2.);
    fragColor=vec4(ck>.5?vec3(.18):vec3(.14),1.); return;
  }
  vec4 col=sampleDoc(tc, tdx, tdy);
  float ck=mod(floor(tc.x*uScale.x/14.)+floor(tc.y*uScale.y/14.),2.);
  vec3 bg=ck>.5?vec3(.7):vec3(.5);
  fragColor=vec4(col.rgb*col.a+bg*(1.-col.a),1.);
}`
