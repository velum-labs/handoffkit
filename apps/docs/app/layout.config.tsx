import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

const githubLink = {
  text: "GitHub",
  url: "https://github.com/velum-labs/handoffkit"
};

/** Chrome for the marketing homepage: section shortcuts plus GitHub. */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: "fusionkit"
  },
  links: [
    {
      text: "Docs",
      url: "/docs",
      active: "nested-url"
    },
    {
      text: "Tools",
      url: "/docs/tools",
      active: "nested-url"
    },
    {
      text: "Guides",
      url: "/docs/guides/inference-endpoint",
      active: "nested-url"
    },
    {
      text: "Concepts",
      url: "/docs/concepts/overview",
      active: "nested-url"
    },
    {
      text: "Reference",
      url: "/docs/reference/commands",
      active: "nested-url"
    },
    githubLink
  ]
};

/**
 * Chrome for the docs pages: only GitHub. The sidebar page tree already lists
 * every section, so repeating the section links above it reads as clutter.
 */
export const docsOptions: BaseLayoutProps = {
  nav: {
    title: "fusionkit"
  },
  links: [githubLink]
};
