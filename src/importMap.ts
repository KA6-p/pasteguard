/**
 * Import name -> PyPI distribution name, for popular packages where they differ.
 *
 * Why this matters: `import yaml` installs `PyYAML`, and `import cv2` installs `opencv-python`.
 * Looking up "yaml" or "cv2" on PyPI directly would give wrong answers.
 *
 * Anything NOT in this table is assumed to have the same name as its PyPI package, and the
 * extractor marks it `mappingConfidence: "assumed"` so Module 3 can treat a miss as "unverified"
 * rather than "does not exist". This table is a starting point and should grow over time.
 */
export const IMPORT_TO_DISTRIBUTION: Readonly<Record<string, string>> = {
  cv2: "opencv-python",
  yaml: "PyYAML",
  PIL: "Pillow",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  jwt: "PyJWT",
  OpenSSL: "pyOpenSSL",
  Crypto: "pycryptodome",
  Cryptodome: "pycryptodomex",
  serial: "pyserial",
  usb: "pyusb",
  win32api: "pywin32",
  win32con: "pywin32",
  win32gui: "pywin32",
  pythoncom: "pywin32",
  attr: "attrs",
  magic: "python-magic",
  docx: "python-docx",
  pptx: "python-pptx",
  fitz: "PyMuPDF",
  MySQLdb: "mysqlclient",
  psycopg2: "psycopg2-binary",
  git: "GitPython",
  zmq: "pyzmq",
  telegram: "python-telegram-bot",
  discord: "discord.py",
  slugify: "python-slugify",
  markdown: "Markdown",
  jose: "python-jose",
  ldap: "python-ldap",
  nacl: "PyNaCl",
  levenshtein: "Levenshtein",
  googleapiclient: "google-api-python-client",
  speech_recognition: "SpeechRecognition",
  tensorflow_hub: "tensorflow-hub",
  flask_cors: "Flask-Cors",
  flask_sqlalchemy: "Flask-SQLAlchemy",
  flask_login: "Flask-Login",
  flask_migrate: "Flask-Migrate",
  flask_wtf: "Flask-WTF",
  rest_framework: "djangorestframework",
  jinja2: "Jinja2",
  werkzeug: "Werkzeug",
  flask: "Flask",
  sqlalchemy: "SQLAlchemy",
  matplotlib: "matplotlib",
  numpy: "numpy",
  pandas: "pandas",
  scipy: "scipy",
  requests: "requests",
  torch: "torch",
  tensorflow: "tensorflow",
};

/**
 * Namespace packages: one import root maps to MANY different PyPI distributions
 * (e.g. `google.generativeai` vs `google.cloud.storage`), so a top-level name alone is not enough.
 * These are reported as "ambiguous" and must never be treated as "package does not exist".
 */
export const NAMESPACE_ROOTS: ReadonlySet<string> = new Set(["google", "azure", "zope", "ruamel", "jaraco", "backports"]);

export type MappingConfidence = "known" | "assumed" | "ambiguous";

export function mapImportToDistribution(topLevel: string): { distribution: string; confidence: MappingConfidence } {
  if (NAMESPACE_ROOTS.has(topLevel)) {
    return { distribution: topLevel, confidence: "ambiguous" };
  }
  const mapped = IMPORT_TO_DISTRIBUTION[topLevel];
  if (mapped !== undefined) {
    return { distribution: mapped, confidence: "known" };
  }
  return { distribution: topLevel, confidence: "assumed" };
}
