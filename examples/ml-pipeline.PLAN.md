---
project: churn-predictor
goal: An end-to-end ML pipeline that trains a customer churn classifier, evaluates it rigorously, and serves predictions via a REST API with model versioning
stack: [python, scikit-learn, pandas, fastapi, pytest, mlflow]
phases:
  - id: scaffold
    name: Environment and data pipeline
    tasks:
      - pyproject.toml with Python 3.12, scikit-learn, pandas, numpy, mlflow, fastapi, pytest
      - Fetch the IBM Telco Customer Churn dataset from the public URL and cache it at data/raw/telco.csv
      - EDA script (src/eda.py) that prints shape, dtypes, missing-value counts, and class balance; outputs data/processed/features.parquet
      - A deterministic train/test split (random_state=42, stratified on Churn) saved to data/splits/
      - Unit test: processed parquet exists, has the right columns, no NaNs in selected features
    checks:
      - file_exists: data/processed/features.parquet
      - cmd: python -m pytest tests/test_data.py -x -q
    done_when: Data is fetched, cleaned, and split; tests confirm integrity

  - id: training
    name: Model training and evaluation
    depends_on: [scaffold]
    tasks:
      - Feature engineering pipeline (scikit-learn Pipeline): OneHotEncoder for categoricals, StandardScaler for numericals
      - Train three models: LogisticRegression, RandomForestClassifier, GradientBoostingClassifier
      - Evaluate on the test set: AUC-ROC, F1 (threshold=0.5), precision, recall, confusion matrix
      - Log every experiment to MLflow (local tracking server): params, metrics, artefacts
      - Select the best model by AUC-ROC; save it to models/best_model.pkl with joblib
      - A test that loads models/best_model.pkl and asserts AUC-ROC ≥ 0.80 on the test set
    checks:
      - file_exists: models/best_model.pkl
      - cmd: python -m pytest tests/test_model.py -x -q
    done_when: Three models trained and compared; best model saved and tested; AUC-ROC ≥ 0.80

  - id: api
    name: Prediction API
    depends_on: [training]
    tasks:
      - FastAPI app with POST /predict (accepts JSON with customer features, returns churn probability + label)
      - Input schema validated with Pydantic; model loaded at startup from models/best_model.pkl
      - GET /model/info returns model version, training AUC, feature names
      - Unit tests with TestClient: happy-path prediction, missing-field 422, /model/info schema
    checks:
      - cmd: python -m pytest tests/test_api.py -x -q
      - cmd: uvicorn src.api:app --port 8001 &; sleep 2; curl -sf -XPOST http://127.0.0.1:8001/predict -H 'Content-Type:application/json' -d '{"tenure":12,"MonthlyCharges":65.0,"Contract":"Month-to-month","InternetService":"Fiber optic","TechSupport":"No","OnlineSecurity":"No","gender":"Male","SeniorCitizen":0,"Partner":"No","Dependents":"No","PhoneService":"Yes","MultipleLines":"No","OnlineBackup":"No","DeviceProtection":"No","StreamingTV":"No","StreamingMovies":"No","PaperlessBilling":"Yes","PaymentMethod":"Electronic check","TotalCharges":780.0}' | python -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'probability' in d else 1)"; kill %1
    done_when: API returns predictions, /model/info works, all tests pass

  - id: monitoring
    name: Drift detection and model versioning
    depends_on: [api]
    tasks:
      - POST /feedback endpoint that records ground-truth labels to data/feedback/labels.jsonl
      - Drift detector (evidently or scipy KS test) that compares incoming feature distribution to training distribution
      - GET /monitor/drift returns per-feature drift scores and an overall drift flag
      - Makefile or script that re-trains and promotes the model when AUC-ROC drops below 0.75 or drift is detected
      - Integration test: write synthetic feedback, call /monitor/drift, assert response schema is correct
    checks:
      - cmd: python -m pytest tests/ -x -q
      - http:
          path: /monitor/drift
          expect_status: 200
    done_when: Feedback ingestion, drift detection and re-training script all work; all tests pass

# Notes for the engine
# - All random operations must use random_state=42 for reproducibility
# - Never commit data files or trained models; add data/ and models/ to .gitignore (but keep data/raw/.gitkeep)
# - Use joblib for serialising sklearn objects, never pickle directly
# - Every numeric result in tests should be bounded (e.g. assert 0 < prob < 1), not an exact match
---

Build a production ML pipeline. The engine must prioritise reproducibility, test coverage, and clean separation between data, training, and serving code.
