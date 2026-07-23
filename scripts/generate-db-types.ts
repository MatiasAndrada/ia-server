import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const DIRECT_URL = process.env.DIRECT_URL;

if (!SUPABASE_URL) {
  console.error("❌ Error: NEXT_PUBLIC_SUPABASE_URL not found in .env");
  process.exit(1);
}

if (!DIRECT_URL) {
  console.error("❌ Error: DIRECT_URL not found in .env");
  process.exit(1);
}

// Extract project ID from URL (e.g., https://xyz.supabase.co -> xyz)
const projectId = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

if (!projectId) {
  console.error("❌ Error: Could not extract project ID from NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}

console.log(`🔄 Generating Supabase types for project: ${projectId}`);

try {
  const outputPath = path.join(process.cwd(), "src/types/supabase.ts");

  // Execute supabase gen types
  const output = execSync(
    `supabase gen types typescript --db-url "${DIRECT_URL}" --schema public`,
    { encoding: "utf-8" }
  );

  // Write to file
  fs.writeFileSync(outputPath, output);

  console.log(`✅ Supabase types generated successfully at: ${outputPath}`);
  console.log(`   Project ID: ${projectId}`);
} catch (error: any) {
  console.error("❌ Error generating types:", error.message);

  if (error.message.includes("supabase: command not found")) {
    console.error("\n💡 Tip: Install Supabase CLI globally with:");
    console.error("   npm install -g @supabase/cli");
  }

  process.exit(1);
}
