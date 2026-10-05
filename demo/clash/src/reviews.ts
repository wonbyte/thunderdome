// Customer reviews, keyed by product slug. Stars are 1 to 5.
export interface Review {
  stars: number;
  text: string;
}

export const REVIEWS: Record<string, Review[]> = {
  "thunderdome-mug": [
    { stars: 5, text: "My coffee won." },
    { stars: 4, text: "Big and sturdy." },
  ],
  "cafe-creme": [
    { stars: 5, text: "Smooth." },
    { stars: 4, text: "Good with cake." },
    { stars: 3, text: "A bit sweet." },
  ],
  "thunder-brew": [{ stars: 2, text: "Too strong for me." }],
};
