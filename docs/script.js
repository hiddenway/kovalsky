const mobileToggle = document.querySelector("#mobile-toggle");
const navLinks = document.querySelector("#nav-links");
const navBar = document.querySelector(".nav");
const copyButtons = document.querySelectorAll("[data-copy]");
const toast = document.querySelector("#toast");
const revealBlocks = document.querySelectorAll(".reveal");
const yearEl = document.querySelector("#year");
const copyTriggers = document.querySelectorAll("[data-copy-trigger]");
const anchorLinks = document.querySelectorAll('a[href^="#"]');

if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

if (mobileToggle && navLinks) {
  mobileToggle.addEventListener("click", () => {
    navLinks.classList.toggle("open");
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
    });
  });
}

function scrollToAnchor(hash, replace = false) {
  if (!hash || hash === "#") {
    return;
  }
  const target = document.querySelector(hash);
  if (!target) {
    return;
  }
  const navHeight = navBar instanceof HTMLElement ? navBar.getBoundingClientRect().height : 0;
  const extraOffset = 12;
  const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - navHeight - extraOffset);
  window.scrollTo({ top, behavior: "smooth" });
  if (replace) {
    window.history.replaceState(null, "", hash);
  } else {
    window.history.pushState(null, "", hash);
  }
}

function showToast(message) {
  if (!toast) {
    return;
  }
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => {
    toast.classList.remove("show");
  }, 1700);
}

async function copyFromSelector(selector) {
  if (!selector) {
    return;
  }
  const source = document.querySelector(selector);
  const text = source?.textContent?.trim();
  if (!text) {
    showToast("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied");
  } catch {
    showToast("Clipboard unavailable");
  }
}

copyButtons.forEach((button) => {
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const selector = button.getAttribute("data-copy");
    await copyFromSelector(selector);
  });
});

copyTriggers.forEach((trigger) => {
  trigger.addEventListener("click", async () => {
    await copyFromSelector(trigger.getAttribute("data-copy-trigger"));
  });
  trigger.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    await copyFromSelector(trigger.getAttribute("data-copy-trigger"));
  });
});

anchorLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    const hash = link.getAttribute("href");
    if (!hash || hash === "#") {
      return;
    }
    event.preventDefault();
    scrollToAnchor(hash, false);
  });
});

window.addEventListener("load", () => {
  if (window.location.hash) {
    window.setTimeout(() => {
      scrollToAnchor(window.location.hash, true);
    }, 0);
  }
});

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.2 },
);

revealBlocks.forEach((block, idx) => {
  block.style.transitionDelay = `${idx * 80}ms`;
  observer.observe(block);
});
