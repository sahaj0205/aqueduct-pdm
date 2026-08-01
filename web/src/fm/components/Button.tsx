import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

/**
 * The one button every screen in the platform uses. Pill-shaped, 8px 16px padding,
 * never smaller — a shrunk pill or a rounded-rectangle reads as a different control
 * from every other button in the product, which is exactly the inconsistency this
 * component exists to remove.
 *
 * `primary` is the one filled, indigo call to action — there should be at most one
 * visible at a time, matching the rest of the brand's CTA discipline.
 */
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "secondary" | "primary" | "ghost";
  size?: "md" | "sm";
}

export function Button({ variant = "secondary", size = "md", className, ...rest }: Props) {
  const cls = [styles.btn, styles[variant], size === "sm" ? styles.sm : "", className].filter(Boolean).join(" ");
  return <button type="button" className={cls} {...rest} />;
}
