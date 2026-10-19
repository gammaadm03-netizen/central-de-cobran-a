import type { CampaignMotif } from '../lib/login-themes';

/** Decorative campaign art: the adjacent campaign name provides the accessible label. */
export default function CampaignSymbol({ motif, className = '' }: { motif: CampaignMotif; className?: string }) {
  return <svg className={`campaign-symbol ${className}`.trim()} viewBox="0 0 400 400" fill="none" aria-hidden="true" focusable="false">
    <circle className="campaign-orbit campaign-orbit-outer" cx="200" cy="200" r="175" />
    <circle className="campaign-orbit campaign-orbit-inner" cx="200" cy="200" r="145" />
    <path className="campaign-spark" d="M55 104v18m-9-9h18M334 278v22m-11-11h22M312 70v12m-6-6h12" />
    {motif === 'ribbon' && <g className="campaign-ribbon">
      <path className="campaign-symbol-soft" d="M153 115c0-41 21-66 47-66s47 25 47 66c0 53-40 111-64 148l-51 79-42-48 53-79c28-42 63-84 63-116 0-17-3-29-6-29s-6 12-6 29c0 6 1 13 4 21l-35 41c-6-16-10-32-10-46Z" />
      <path className="campaign-symbol-main" d="M153 115c0-41 21-66 47-66s47 25 47 66c0 16-4 32-10 48l-35-41c3-8 4-15 4-21 0-17-3-29-6-29s-6 12-6 29c0 32 35 74 63 116l53 79-42 48-51-79c-24-37-64-95-64-150Z" />
      <path className="campaign-ribbon-fold" d="M162 81c10-12 23-18 38-18s28 6 38 18c-12-8-25-12-38-12s-26 4-38 12Z" />
      <path className="campaign-symbol-highlight" d="m184 167 71 108" />
    </g>}
    {motif === 'flower' && <g className="campaign-flower">
      {[0, 60, 120, 180, 240, 300].map(angle => <ellipse key={angle} className={angle % 120 ? 'campaign-symbol-soft' : 'campaign-symbol-main'} cx="200" cy="137" rx="43" ry="75" transform={`rotate(${angle} 200 200)`} />)}
      <circle className="campaign-flower-center" cx="200" cy="200" r="42" />
      <path className="campaign-symbol-highlight" d="M179 196c5-12 21-18 34-10" />
    </g>}
    {motif === 'confetti' && <g className="campaign-confetti">
      <path className="campaign-symbol-main" d="m95 307 48-159 111 111-159 48Z" />
      <path className="campaign-symbol-soft" d="m132 185 95 95-34 10-71-71 10-34Z" />
      <path className="campaign-confetti-stream" d="M183 151c-13-61 81-19 63-80M241 204c62 18 21-75 83-63M222 170l63-63" />
      <path className="campaign-symbol-soft" d="m151 81 17 14-15 18-17-15 15-17Zm150 136 19 5-6 22-19-5 6-22Zm-40-67 14 13-14 16-15-13 15-16Z" />
      <circle className="campaign-symbol-main" cx="302" cy="78" r="9" /><circle className="campaign-symbol-main" cx="120" cy="123" r="7" />
    </g>}
    {motif === 'flags' && <g className="campaign-flags">
      <path className="campaign-flags-line" d="M58 123c95 50 189 50 284 0M66 213c95 50 173 50 268 0" />
      <path className="campaign-symbol-main" d="m83 137 57 19-11 63-23-24-32 9 9-67Zm133 24 60-9 10 65-30-11-25 22-15-67ZM91 226l57 18-10 60-24-20-32 8 9-66Zm132 23 58-12 11 63-32-11-23 25-14-65Z" />
      <path className="campaign-symbol-soft" d="m148 157 60 5-5 62-27-16-29 15 1-66Zm138-7 52-20 18 60-31-5-19 24-20-59ZM156 247l58 5-4 63-27-19-29 15 2-64Z" />
    </g>}
    {motif === 'sun' && <g className="campaign-sun">
      {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => <path key={angle} className="campaign-sun-ray" d="M200 62v36" transform={`rotate(${angle} 200 200)`} />)}
      <circle className="campaign-symbol-main" cx="200" cy="200" r="80" />
      <path className="campaign-symbol-highlight" d="M155 205c0-29 22-51 49-51" />
      <path className="campaign-symbol-soft" d="M250 272c-11 6-24 9-37 9-44 0-80-36-80-80 0-13 3-26 9-37-2 57 43 105 108 108Z" />
    </g>}
    {motif === 'star' && <g className="campaign-star">
      <path className="campaign-symbol-main" d="m200 56 43 88 97 14-70 69 17 97-87-46-87 46 17-97-70-69 97-14 43-88Z" />
      <path className="campaign-symbol-soft" d="m200 56 0 151 87 117-87-46-87 46 87-117-140-49 97-14 43-88Z" />
      <path className="campaign-symbol-highlight" d="m200 100 27 56 58 9" />
    </g>}
    <circle className="campaign-dot" cx="87" cy="280" r="4" /><circle className="campaign-dot" cx="307" cy="167" r="3" />
  </svg>;
}
