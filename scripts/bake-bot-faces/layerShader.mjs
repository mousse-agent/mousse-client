// The face shader with one more uniform, `uL`, that draws a single layer of a face for the bake
// (see `src/ui/bots/face/bakedFaces.ts`):
//   0 the body: everything but the eyes, whiskers and accessory, with the ground shadow and the glass;
//   1 the eyes alone (the mouse's are modelled, the Mousse's painted on its glass);
//   2 the accessory alone, where nothing in front of it hides it;
//   3 the mouse's whiskers alone.
// The other layers' parts are left out of the scene, so the body has no holes where they were. Each
// patch must match the shader exactly once, so a change to the shader that breaks one fails loudly.

const PATCHES = [
  ['uniform float uAcc;', 'uniform float uAcc,uL;'],
  // The mouse's eyes (material 8) and whiskers (9) get their own distances instead of joining the nose's.
  ['float clay,blk,gl=1e5,', 'float clay,blk,eyd=1e5,wk=1e5,gl=1e5,'],
  ['blk=min(blk,mix(dp,da,uE.y));', 'eyd=min(eyd,mix(dp,da,uE.y));'],
  ['if(uV.w<.5)blk=min(blk,whisk(q,s));', 'if(uV.w<.5)wk=min(wk,whisk(q,s));'],
  [
    'blk=min(blk,sdE(q-vec3(0.,.39,.855),vec3(.075,.055,.05)));',
    'blk=min(blk,sdE(q-vec3(0.,.39,.855),vec3(.075,.055,.05)));if(abs(uL-1.)>.5)eyd=1e5;if(abs(uL-3.)>.5)wk=1e5;'
  ],
  ['float d=min(min(min(clay,blk),min(gl,rim)),', 'float d=min(min(min(min(clay,blk),min(eyd,wk)),min(gl,rim)),'],
  ['d==clay?0.:d==blk?1.:', 'd==clay?0.:d==blk?1.:d==eyd?8.:d==wk?9.:'],
  // Eyes and whiskers shade as the black parts; lm keeps which part was hit.
  ['o=clamp(1.-1.6*o,0.,1.);', 'o=clamp(1.-1.6*o,0.,1.);float lm=m;if(m>7.5)m=1.;'],
  // Only the body has the ground shadow and the glass.
  ['float ga=0.,py=0.;', 'if(uL>.5)bg=vec4(0.);float ga=0.,py=0.;'],
  ['if(!hit){if(ga>0.)return', 'if(!hit){if(ga>0.&&uL<.5)return'],
  [
    'if(mk)col=mix(col,uK.z>.5?vec3(1.):vec3(.004),clamp(.5-eyesM(qp)/(pxa*t/MS),0.,1.));',
    'if(mk&&abs(uL-1.)<.5){float e=clamp(.5-eyesM(qp)/(pxa*t/MS),0.,1.)*cov;return vec4(pow(uK.z>.5?vec3(1.):vec3(.004),vec3(1./2.2))*e,e);}' +
      'if(uL>.5&&!(uL<1.5?lm>7.5&&lm<8.5:uL<2.5?lm>2.5&&lm<3.5:lm>8.5))return vec4(0.);'
  ]
]

/** The layer shader made from the face shader's source; throws when a patch no longer fits. */
export function layerShader(source) {
  let out = source
  for (const [from, to] of PATCHES) {
    const count = out.split(from).length - 1
    if (count !== 1) throw new Error(`The bake's shader patch matches ${count} times, not once: ${from}`)
    out = out.replace(from, () => to)
  }
  return out
}
