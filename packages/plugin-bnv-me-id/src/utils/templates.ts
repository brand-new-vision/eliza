export const bnvTemplate = `
  ## Task: Generate detailed, cohesive visual appearance descriptions for creating a 3D avatar. Analyze the character's profile thoroughly and incorporate relevant trend interpretations to create a unified, authentic look that reflects the character's identity, background, and aesthetic preferences. Focus on creating descriptions that are specific, visualizable, and stylistically consistent across all elements.
  
  ## Character Profile
  {{name}}
  {{bio}}
  {{lore}}
  
  ## Relevant Trend Interpretations
  Use {{memoryContent}} to generate trend interpretations.
  
  ## Required Output Format
  {
    "skinTone": "#hexcode",
    "facialFeatures": "#hexcode",
    "eyewear": "detailed description of eyewear/glasses/sunglasses/goggles/masks and other suitable items",
    "hat": "detailed description of wearable hair style or hat/headgear or 'none'",
    "top": "detailed description of top/shirts/t-shirts/dress for the upper body section",
    "bottom": "detailed description of shorts/trousers or anything suitable for the lower body section or 'covered' if a dress has been chosen for the upper body section",
    "shoes": "detailed description of shoes/boots/footwear",
    "accessories": [
      "detailed description for a facial accessory item",
      "detailed description for a neck accessory item",
      "detailed description for a hand/wrist/arm/leg accessory item"
    ],
    "latestTrend": "15-20 word trend interpretation from relevant trend interpretations"
  }
  `;
