/** What the people in the demo call say, and what the "AI" replies. All fictional. */

export const CALL = {
  q1: "Thanks for making time today, Alex. To start, can you tell me about a time you made a large web app much faster?",
  a1: "Sure. At my last company our checkout page was the slowest part of the app, so I led the work to fix it.",
  q2: "Nice. How would you build a design system that several product teams can adopt without slowing them down?",
  chat: "What should I ask them at the end?",
};

const ANSWERS: [RegExp, string][] = [
  [
    /made a large web app much faster/,
    `**Cut checkout load time from 4.1s to 1.6s by splitting the bundle and removing request waterfalls.**

- **Situation:** checkout was our slowest page, and mobile conversion was dropping.
- **Action:** profiled with Lighthouse and React Profiler, code-split routes, fetched data in parallel, lazy-loaded third-party scripts.
- **Result:** LCP down 61%, mobile conversion up 8% within a month.`,
  ],
  [
    /design system that several product teams/,
    `**Ship it as a versioned package: tokens first, components second, and make adopting it the easy path.**

- **Tokens:** colour, spacing and type as CSS variables, so teams theme without code changes.
- **Components:** accessible primitives with escape hatches, documented in Storybook with do's and don'ts.
- **Adoption:** codemods for upgrades, an open contribution model, and adoption tracked per team.`,
  ],
  [
    /What should I ask them at the end/,
    `**Ask about how success is measured, not about perks:**

- "What would a great first 90 days look like in this role?"
- "How do product and engineering decide what to build next?"
- "What's the biggest frontend challenge the team has this year?"`,
  ],
];

const NOTES = `## Summary
Interview for a senior frontend role. Covered web performance and design systems.

## Discussion points
- Checkout performance work: load time from 4.1s to 1.6s, mobile conversion up 8%.
- Design system approach: tokens first, versioned package, codemods for upgrades.

## Next steps
- Recruiter to share next round details this week.`;

const INTERVIEWER = [
  "Hi Alex, thanks for joining. Let's start with this: tell me about a project you're proud of, and what your role in it was.",
  "That's a solid result. How did you decide which performance fixes to tackle first?",
  "Makes sense. Last one: how do you handle a disagreement with a designer about how a component should behave?",
  "Thanks Alex, that's everything from me. Great talking with you. [END]",
];

const FEEDBACK = `## Overall
**7.5 / 10.** Clear, well-structured answers with real numbers. The weakest moment was prioritisation, where the reasoning was implied rather than stated.

## Question by question
*Tell me about a project you're proud of.*
- **Worked:** concrete metrics (4.1s → 1.6s, +8% conversion) and a clear personal role.
- **Improve:** open with the business problem before the technical one.

*How did you decide which fixes to tackle first?*
- **Worked:** mentioned profiling before changing anything.
- **Improve:** name the rule you used, e.g. impact on LCP divided by effort.

## Practise next
1. Lead every answer with a one-sentence headline.
2. Make trade-offs explicit when you explain decisions.
3. Keep answers under two minutes.`;

const MOCK_ANSWERS = [
  "I'm proudest of rebuilding our checkout. It was the slowest page we had, so I profiled it, split the bundle and removed the request waterfalls. Load time went from four seconds to under two, and mobile conversion went up eight percent.",
  "I measured first. I ranked fixes by how much they moved largest contentful paint against how long they'd take, and did the cheap, high impact ones first.",
  "I try to get back to the user problem. I'd prototype both options quickly, test them with a few users, and let the results decide rather than opinions.",
];
export const MOCK = { answers: MOCK_ANSWERS };

/** Picks the canned reply for an OpenAI-format chat request body. */
export function pickReply(body: { messages?: { role: string; content: unknown }[] }): string {
  const all = JSON.stringify(body);
  if (all.includes("interview coach")) return FEEDBACK;
  if (all.includes("running a practice interview")) {
    const asked = body.messages?.filter((m) => m.role === "assistant").length ?? 0;
    return INTERVIEWER[Math.min(asked, INTERVIEWER.length - 1)];
  }
  if (all.includes("crisp call notes")) return NOTES;
  // Typed questions come last in the prompt, so check those before the transcript.
  const last = JSON.stringify(body.messages?.at(-1) ?? "");
  const tail = last.slice(last.lastIndexOf("</transcript>"));
  const match = ANSWERS.find(([re]) => re.test(tail)) ?? [...ANSWERS].reverse().find(([re]) => re.test(last));
  return match?.[1] ?? "**Here's a short answer.**\n\n- One point.\n- Another point.";
}

const day = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();

export const REPLIES = {
  pastSessions: [
    {
      id: "s3",
      startedAt: day(23, 15),
      endedAt: day(23, 15) + 38 * 60_000,
      mode: "interview",
      lines: [
        { id: 0, source: "them", text: "Walk me through how you'd debug a memory leak in a React app." },
        { id: 1, source: "me", text: "I'd start with a heap snapshot before and after the suspect interaction." },
      ],
      answers: [{ id: 0, kind: "notes", prompt: "Notes", text: NOTES }],
    },
    {
      id: "s2",
      startedAt: day(22, 11),
      endedAt: day(22, 11) + 24 * 60_000,
      mode: "interview",
      mock: true,
      lines: [{ id: 0, source: "them", text: INTERVIEWER[0] }],
      answers: [{ id: 0, kind: "notes", prompt: "Mock interview feedback", text: FEEDBACK }],
    },
    {
      id: "s1",
      startedAt: day(20, 17),
      endedAt: day(20, 17) + 52 * 60_000,
      mode: "meeting",
      lines: [{ id: 0, source: "them", text: "Let's go over the Q4 roadmap and what's slipping." }],
      answers: [],
    },
  ],
};
