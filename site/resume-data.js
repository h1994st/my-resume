// Duna Feline's resume as the site's replica shows it: pure data (no DOM), importable from the
// browser and from Node (site/strings.mjs). Text is typographic exactly as the PDFs print it
// (curly quotes, en dashes, %, é), copied from canonical/resume.tex, the granary variant, and
// common/facts/*.tex. site/check.sh fails if any string here is missing from the real PDFs, except
// items marked `demo: true` and dates marked `demoDates: true` (act 5 of the demo, not in the repo).
// Ids are stable across states so state changes animate as moves, exits, and entries.

export const PROFILE = {
  name: "Duna Feline",
  email: "duna.feline@example.com",
  homepage: "example.com",
  phone: "+1 (555) 010-0199",
};

// --- Facts (common/facts/*.tex) ----------------------------------------------------------

const WINDOWSILL = {
  id: "windowsill",
  kind: "role",
  title: "Head of Windowsill Operations",
  org: "Sunbeam Estates",
  location: "Living Room",
  dates: "Apr 2023 – Present",
};
const CARDBOARD = {
  id: "cardboard",
  kind: "role",
  title: "Senior Box Inspector",
  org: "Cardboard Box Co.",
  location: "Garage",
  dates: "Feb 2020 – Mar 2023",
};
const CATNIP_FARMS = {
  id: "catnip-farms",
  kind: "role",
  title: "Professional Napper",
  org: "Catnip Farms",
  location: "Any Warm Laundry",
  dates: "Jul 2017 – Jan 2020",
};
const SHELTER_INTERN = {
  id: "shelter-intern",
  kind: "role",
  title: "Kitten Intern",
  org: "Happy Paws Shelter",
  location: "Cage 3B",
  dates: "Jun 2016 – Sep 2016",
};

const RED_DOT_TRACKER = {
  id: "red-dot-tracker",
  kind: "project",
  title: "Red Dot Tracker, laser-pointer pursuit analytics",
  org: "Open source",
  dates: "May 2021 – Present",
  link: "github.com/example/red-dot-tracker",
  note: "1.2k+ stars, 0 dots caught",
};
const PURROMETHEUS = {
  id: "purrometheus",
  kind: "project",
  title: "Purrometheus, food-bowl monitor",
  org: "Weekend project",
  dates: "Jan 2022 – Present",
  link: "github.com/example/purrometheus",
  note: "used by two very demanding cats",
};
const HAIRBALL = {
  id: "hairball",
  kind: "project",
  title: "Hairball, surprise-delivery planner",
  dates: "Mar 2019 – Aug 2020",
  link: "github.com/example/hairball",
};

const EDUCATION = {
  id: "education",
  title: "Education",
  items: [
    {
      id: "calico-phc",
      kind: "degree",
      school: "Calico University",
      location: "Catnip Valley",
      degree: "Ph.C. in Feline Philosophy",
      dates: "Sep 2012 – Jun 2017",
      dissertation: "Landing on Your Feet: A Unified Theory of Self-Righting",
    },
    {
      id: "tabby-bs",
      kind: "degree",
      school: "Tabby Institute of Technology",
      degree: "B.S. in Box Science",
      dates: "Sep 2008 – May 2012",
    },
  ],
};

// Titles carry the period the template appends (none after "?").
const PUBS = {
  feline2019curiosity: {
    title: "Curiosity Killed the Rat: A Field Study of Indoor Rodent Detection.",
    venue: "Proc. of the Annual Conference on Whisker Sciences (ACWS 2019)",
    award: "Best Paper Award",
    authors: "Duna Feline, Dudu Whiskers, and Nangnang Mittens",
  },
  whiskers2017box: {
    title: "If It Fits, It Sits: Are Cardboard Boxes Ready for Production?",
    venue: "Proc. of the Workshop on Boxes and Containers (WBC 2017)",
    authors: "Dudu Whiskers, Duna Feline, and Mochi Paws",
  },
  feline2016yarn: {
    title: "Untangling the Yarn: An Incremental Approach to Knot Resolution.",
    venue: "Journal of Feline Engineering, vol. 9",
    authors: "Duna Feline and Nangnang Mittens",
  },
  feline2015flap: {
    title: "Schrödinger’s Cat Flap: Doors That Are Both Open and Closed.",
    venue: "Proc. of the Workshop on Hot Topics in Doors (HotDoors 2015)",
    authors: "Duna Feline, Mochi Paws, and Dudu Whiskers",
  },
};
// Listed newest first, as the template prints them; `n` is the printed number.
const pubs = (...ids) => ids.map((id, i) => ({ id, kind: "pub", n: i + 1, ...PUBS[id] }));

const line = (id, text, years) => ({ id, kind: "line", text, years });

// Bullets as written in the resume files, by stable id.
const BULLETS = {
  "w-red-dot":
    "Initiated and led “Operation Red Dot”, a household-wide laser-pointer pursuit program spanning 12 rooms, with a perfectly consistent record of zero dots caught",
  "w-birds":
    "Monitored 400+ birds and 37 squirrels a day from the bay window, chirping alerts in under 2 seconds",
  "w-breakfast":
    "Cut 5 a.m. breakfast latency by 60% with a new wake-up protocol: paw tap, face sit, vase nudge",
  "w-mentor":
    "Mentored two younger cats in advanced counter surfing; both were promoted to Lap Supervisor",
  "w-dog":
    "Negotiated a mutual-ignorance treaty with the dog, sustaining 1,000+ incident-free days",
  "c-boxes":
    "Inspected 1,200 boxes of every size, confirming “if it fits, I sits” across 98% of form factors",
  "c-scratch":
    "Designed a nine-step scratching schedule that kept claws sharp and cut couch damage by 55%",
  "c-hairball":
    "Shipped “Hairball Express”, a chirp that warns humans 30 seconds before delivery (on the rug)",
  "c-naps": "Raised nap availability from 16 to 20 hours per day without missing a single meal",
  "n-sunbeam":
    "Logged 2M sunbeam-minutes of napping across a multi-room portfolio of beds, boxes, and baskets",
  "n-lap":
    "Reduced lap-acquisition time by 40% by rerouting approach paths around the coffee table",
  "n-copycat":
    "Developed “Copycat”, a technique that replays the dog’s begging routine to unlock extra treats",
  "s-mice":
    "Delivered three toy mice per day to the volunteers’ shoes, establishing a reputation for reliable gifting",
  "r-tracker":
    "Created an open-source tracker that chases the red dot across walls and pounces on every outlier",
  "r-community": "Grew a community of 40+ feline contributors across three households",
  "p-charts":
    "Charts food-bowl levels, nap durations, and 3 a.m. zoomies, with alerts routed to the nearest human",
  "h-plans":
    "Plans each surprise delivery for the most expensive rug in the house, with 99% placement accuracy",
};
// An entry with the given bullets, in the given order.
const withBullets = (entry, ...ids) => ({
  ...entry,
  bullets: ids.map((id) => ({ id, text: BULLETS[id] })),
});

// --- canonical/resume.tex ----------------------------------------------------------------

const canonical = {
  headline: "Senior Mischief Engineer, Ph.C., Certified Box Inspector",
  summary:
    "Curious-by-nature cat with a Ph.C. (Doctor of Philosophy in Cat) and 5+ years of cat-tree scratching experience. Always lands on her feet: takes ambiguous cardboard boxes from first sniff to full occupancy, and ships naps, purrs, and head boops that humans rely on daily (rarely knocking things over).",
  skills: [
    [
      "Languages/Tools",
      "Meow, Purr, Chirp, Slow Blink, Hiss (deprecated), Scratching Post, Laser Pointer, Yarn",
    ],
    ["Skills", "Box Inspection, Napping, Bird Watching, Counter Surfing, Zoomies, Lap Acquisition"],
  ],
  sections: [
    {
      id: "experience",
      title: "Experience",
      items: [
        withBullets(WINDOWSILL, "w-red-dot", "w-birds", "w-breakfast", "w-mentor", "w-dog"),
        withBullets(CARDBOARD, "c-boxes", "c-scratch", "c-hairball", "c-naps"),
        withBullets(CATNIP_FARMS, "n-sunbeam", "n-lap", "n-copycat"),
        withBullets(SHELTER_INTERN, "s-mice"),
      ],
    },
    {
      id: "projects",
      title: "Projects",
      items: [
        withBullets(RED_DOT_TRACKER, "r-tracker", "r-community"),
        withBullets(PURROMETHEUS, "p-charts"),
        withBullets(HAIRBALL, "h-plans"),
      ],
    },
    EDUCATION,
    {
      id: "publications",
      title: "Publications",
      items: pubs("feline2019curiosity", "whiskers2017box", "feline2016yarn", "feline2015flap"),
    },
    {
      id: "service",
      title: "Service",
      items: [
        line(
          "acws-pc",
          "Annual Conference on Whisker Sciences (ACWS) Program Committee",
          "2022–2025",
        ),
        line("jfe-reviewer", "Journal of Feline Engineering Reviewer", "2020–2025"),
        line("kitten-mentor", "Kitten Socialization Program Mentor", "2021"),
        line(
          "cat-cafe-club",
          "Cat Café Nap Review Club Organizer (monthly, treats provided)",
          "2019–2025",
        ),
      ],
    },
    {
      id: "honors",
      title: "Honors & Awards",
      items: [
        line(
          "cats-whiskers",
          "The Cat’s Whiskers Award for Excellence in Mischief, Sunbeam Estates",
          "2024",
        ),
        line("acws-best-paper", "ACWS Best Paper Award", "2019"),
        line(
          "golden-whisker",
          "Golden Whisker Fellowship, Calico University (Top 5% of the litter)",
          "2013, 2014",
        ),
        line("deans-list", "Dean’s List (“Top Cat”), Tabby Institute of Technology", "2009–2012"),
      ],
    },
  ],
};

// --- applications/2026-09-granary-senior-mouser/resume.tex --------------------------------

const granary = {
  headline: "Rodent Operations Specialist, Ph.C.",
  summary:
    "Vigilant cat with a Ph.C. (Doctor of Philosophy in Cat) and 5+ years of cat-tree scratching experience, specializing in patrol, early detection, and fast response. Published on indoor rodent detection, comfortable on long quiet shifts, and happy to train the next litter.",
  skills: [
    ["Languages/Tools", "Meow, Chirp, Slow Blink, Scratching Post, Laser Pointer"],
    ["Skills", "Bird Watching, Box Inspection, Pouncing, Night Vision, Kitten Mentoring"],
  ],
  sections: [
    {
      id: "experience",
      title: "Experience",
      items: [
        withBullets(WINDOWSILL, "w-birds", "w-red-dot", "w-mentor"),
        withBullets(CARDBOARD, "c-boxes", "c-hairball", "c-scratch"),
        withBullets(CATNIP_FARMS, "n-lap"),
        withBullets(SHELTER_INTERN, "s-mice"),
      ],
    },
    {
      id: "projects",
      title: "Projects",
      items: [withBullets(RED_DOT_TRACKER, "r-tracker")],
    },
    EDUCATION,
    {
      id: "publications",
      title: "Publications",
      items: pubs("feline2019curiosity"),
    },
  ],
};

// --- Act 5 (demo only): canonical after "Got the job: Senior Mouser at Granary & Sons" ------

const updated = structuredClone(canonical);
{
  const experience = updated.sections.find((s) => s.id === "experience");
  const windowsill = experience.items.find((item) => item.id === "windowsill");
  windowsill.dates = "Apr 2023 – Oct 2026";
  windowsill.demoDates = true;
  experience.items.unshift({
    id: "granary",
    kind: "role",
    demo: true,
    title: "Senior Mouser",
    org: "Granary & Sons",
    location: "Grain Warehouse",
    dates: "Nov 2026 – Present",
    bullets: [],
  });
}

export const STATES = { canonical, granary, updated };
