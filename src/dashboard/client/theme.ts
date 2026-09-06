import { createTheme } from "@mantine/core";

export const dashboardTheme = createTheme({
  primaryColor: "orange",
  primaryShade: 7,
  defaultRadius: "sm",
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  headings: { fontWeight: "650" },
  components: {
    Button: { defaultProps: { size: "sm" } },
    Select: {
      defaultProps: {
        searchable: true,
        comboboxProps: { withinPortal: true, zIndex: 350 },
      },
    },
    MultiSelect: {
      defaultProps: {
        searchable: true,
        comboboxProps: { withinPortal: true, zIndex: 350 },
      },
    },
    Modal: {
      defaultProps: {
        centered: true,
        overlayProps: { backgroundOpacity: 0.65 },
        zIndex: 300,
      },
    },
  },
});
